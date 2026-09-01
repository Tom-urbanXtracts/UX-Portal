-- Private, portal-controlled product and COA assets. Browser roles never read
-- storage metadata directly; Edge Functions issue short-lived signed URLs only
-- after portal authentication and approval-state checks.

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'portal-assets',
  'portal-assets',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.portal_asset (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('product_image', 'coa_document')),
  owner_type text not null check (owner_type in ('canix_item', 'canix_package')),
  owner_id bigint not null check (owner_id > 0),
  bucket_id text not null default 'portal-assets' check (bucket_id = 'portal-assets'),
  storage_path text not null unique,
  original_filename text not null,
  content_type text not null check (content_type in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
  )),
  declared_size_bytes bigint not null check (declared_size_bytes between 1 and 20971520),
  observed_size_bytes bigint check (observed_size_bytes between 1 and 20971520),
  state text not null default 'pending_upload' check (state in (
    'pending_upload', 'pending_review', 'active', 'quarantined', 'archived'
  )),
  review_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_by_email text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (purpose = 'product_image' and owner_type = 'canix_item' and content_type like 'image/%')
    or
    (purpose = 'coa_document' and owner_type = 'canix_package' and content_type = 'application/pdf')
  )
);

create index if not exists portal_asset_owner_idx
  on public.portal_asset (owner_type, owner_id, purpose, state, updated_at desc);

create unique index if not exists portal_asset_one_active_owner_idx
  on public.portal_asset (owner_type, owner_id, purpose)
  where state = 'active';

alter table public.portal_product_content
  add column if not exists image_asset_id uuid references public.portal_asset(id) on delete set null;

alter table public.canix_package_coa
  add column if not exists portal_asset_id uuid references public.portal_asset(id) on delete set null;

create index if not exists portal_product_content_asset_idx
  on public.portal_product_content (image_asset_id)
  where image_asset_id is not null;

create index if not exists canix_package_coa_asset_idx
  on public.canix_package_coa (portal_asset_id)
  where portal_asset_id is not null;

alter table public.portal_asset enable row level security;
revoke all on table public.portal_asset from public, anon, authenticated;
grant all on table public.portal_asset to service_role;

-- No storage.objects policy is created for this bucket. The private Storage API
-- is accessed only with the service role after the portal endpoint authorizes
-- the request. Existing policies for unrelated buckets are left untouched.

comment on table public.portal_asset is
  'Private portal-controlled product images and COA documents. Only active assets may receive signed read URLs.';
comment on column public.portal_asset.state is
  'Uploads are fail-closed: pending files do not appear in the catalog until an authorized reviewer activates them.';

create or replace function public.portal_review_asset(
  p_asset_id uuid,
  p_decision text,
  p_note text,
  p_reviewer_id uuid,
  p_reviewer_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.portal_asset%rowtype;
  changed public.portal_asset%rowtype;
begin
  if p_decision not in ('approve', 'quarantine') then
    raise exception 'Choose approve or quarantine';
  end if;

  select * into target
  from public.portal_asset
  where id = p_asset_id
  for update;

  if target.id is null then raise exception 'Asset not found'; end if;
  if target.state <> 'pending_review' then
    raise exception 'Only an uploaded asset awaiting review can be decided';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(target.owner_type || ':' || target.owner_id::text || ':' || target.purpose, 0)
  );

  if p_decision = 'approve' then
    update public.portal_asset
    set state = 'archived', updated_at = now()
    where owner_type = target.owner_type
      and owner_id = target.owner_id
      and purpose = target.purpose
      and state = 'active'
      and id <> target.id;
  end if;

  update public.portal_asset
  set state = case when p_decision = 'approve' then 'active' else 'quarantined' end,
      review_note = nullif(trim(coalesce(p_note, '')), ''),
      reviewed_by = p_reviewer_id,
      reviewed_by_email = p_reviewer_email,
      reviewed_at = now(),
      updated_at = now()
  where id = target.id
  returning * into changed;

  if p_decision = 'approve' and target.purpose = 'product_image' then
    update public.portal_product_content
    set image_asset_id = target.id, updated_at = now()
    where canix_item_id = target.owner_id;
    if not found then
      raise exception 'Create the Canix-linked product content row before approving its image';
    end if;
  elsif p_decision = 'approve' and target.purpose = 'coa_document' then
    update public.canix_package_coa
    set portal_asset_id = target.id
    where package_id = target.owner_id;
    if not found then
      raise exception 'The Canix package does not have a current normalized COA row';
    end if;
  end if;

  return to_jsonb(changed);
end;
$$;

revoke all on function public.portal_review_asset(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_review_asset(uuid, text, text, uuid, text)
  to service_role;

-- Atomic, privacy-preserving public-intake rate claims. The Edge Function
-- supplies only an HMAC scope key; raw IP addresses and unhashed identifiers
-- are never stored here.
create table if not exists public.portal_public_intake_rate_limit (
  scope_key text not null,
  window_start timestamptz not null,
  hit_count integer not null check (hit_count > 0),
  updated_at timestamptz not null default now(),
  primary key (scope_key, window_start)
);

create or replace function public.portal_claim_public_intake_rate(
  p_scope_key text,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed public.portal_public_intake_rate_limit%rowtype;
  current_window timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_scope_key is null or length(p_scope_key) < 32 then
    raise exception 'A protected intake scope is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'The public intake limit must be between one and twenty';
  end if;

  insert into public.portal_public_intake_rate_limit (
    scope_key, window_start, hit_count, updated_at
  ) values (
    p_scope_key, current_window, 1, now()
  )
  on conflict (scope_key, window_start) do update set
    hit_count = portal_public_intake_rate_limit.hit_count + 1,
    updated_at = now()
  where portal_public_intake_rate_limit.hit_count < p_limit
  returning * into claimed;

  return claimed.scope_key is not null;
end;
$$;

alter table public.portal_public_intake_rate_limit enable row level security;
revoke all on table public.portal_public_intake_rate_limit from public, anon, authenticated;
grant all on table public.portal_public_intake_rate_limit to service_role;
revoke all on function public.portal_claim_public_intake_rate(text, integer)
  from public, anon, authenticated;
grant execute on function public.portal_claim_public_intake_rate(text, integer)
  to service_role;
