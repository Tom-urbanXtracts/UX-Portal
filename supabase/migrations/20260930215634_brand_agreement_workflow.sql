-- Immutable, malware-scanned Brand agreement submissions. Browser clients do
-- not receive direct table or Storage access: portal-brand-operations performs
-- the current membership/role check and issues short-lived document URLs.

alter table public.portal_brand_agreement
  add column if not exists submitted_by uuid references auth.users(id) on delete set null,
  add column if not exists submitted_by_email text,
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_by_email text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_decision text
    check (review_decision is null or review_decision in ('approved', 'changes_requested')),
  add column if not exists review_note text,
  add column if not exists brand_response_note text,
  add column if not exists archived_by uuid references auth.users(id) on delete set null;

alter table public.portal_brand_agreement
  drop constraint if exists portal_brand_agreement_status_check;
alter table public.portal_brand_agreement
  add constraint portal_brand_agreement_status_check
  check (status in (
    'draft', 'in_review', 'changes_requested', 'awaiting_signature', 'active',
    'expiring', 'expired', 'superseded', 'terminated'
  ));

create table if not exists public.portal_brand_agreement_document (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null unique
    references public.portal_brand_agreement(id) on delete restrict,
  object_path text not null unique,
  original_name text not null,
  content_type text not null check (content_type = 'application/pdf'),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_state text not null check (scan_state = 'clean'),
  scan_provider text not null,
  uploaded_by_type text not null check (uploaded_by_type in ('internal', 'brand')),
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_email text,
  created_at timestamptz not null default now()
);

create table if not exists public.portal_brand_agreement_renewal_notice (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  agreement_id uuid not null references public.portal_brand_agreement(id) on delete cascade,
  reminder_days integer not null check (reminder_days >= 0),
  remind_on date not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'dismissed', 'skipped')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agreement_id, reminder_days)
);

create index if not exists portal_brand_agreement_review_queue_idx
  on public.portal_brand_agreement (organization_id, status, submitted_at desc)
  where status in ('in_review', 'changes_requested');
create index if not exists portal_brand_agreement_expiry_idx
  on public.portal_brand_agreement (organization_id, expires_on)
  where visibility = 'published' and status in ('active', 'expiring');
create unique index if not exists portal_brand_agreement_one_current_idx
  on public.portal_brand_agreement (organization_id, requirement_code)
  where visibility = 'published' and status in ('active', 'expiring');
create index if not exists portal_brand_agreement_renewal_due_idx
  on public.portal_brand_agreement_renewal_notice (status, remind_on, organization_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-brand-agreements', 'portal-brand-agreements', false, 10485760,
  array['application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.portal_brand_agreement_document enable row level security;
alter table public.portal_brand_agreement_renewal_notice enable row level security;

revoke all on table public.portal_brand_agreement_document,
  public.portal_brand_agreement_renewal_notice from public, anon, authenticated;
grant all on table public.portal_brand_agreement_document,
  public.portal_brand_agreement_renewal_notice to service_role;
grant usage, select on sequence public.portal_brand_agreement_renewal_notice_id_seq
  to service_role;

create or replace function public.portal_publish_brand_agreement(
  p_agreement_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_review_note text default null
)
returns public.portal_brand_agreement
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.portal_brand_agreement%rowtype;
  previous public.portal_brand_agreement%rowtype;
  published_status text;
  reminder integer;
begin
  select * into target
  from public.portal_brand_agreement
  where id = p_agreement_id
  for update;

  if not found then
    raise exception 'Agreement not found';
  end if;
  if target.status <> 'in_review' or target.visibility <> 'internal' then
    raise exception 'Only an agreement awaiting review can be published';
  end if;
  if not exists (
    select 1 from public.portal_brand_agreement_document
    where agreement_id = target.id and scan_state = 'clean'
  ) then
    raise exception 'A verified clean agreement PDF is required';
  end if;

  published_status := case
    when target.expires_on is not null and target.expires_on < current_date then 'expired'
    when target.expires_on is not null and target.expires_on <= current_date + 90 then 'expiring'
    else 'active'
  end;

  if published_status in ('active', 'expiring') then
    select * into previous
    from public.portal_brand_agreement
    where organization_id = target.organization_id
      and requirement_code = target.requirement_code
      and id <> target.id
      and visibility = 'published'
      and status in ('active', 'expiring')
    order by published_at desc nulls last, updated_at desc
    limit 1
    for update;

    if found then
      update public.portal_brand_agreement
      set status = 'superseded', visibility = 'archived', archived_at = now(),
          archived_by = p_actor_id, updated_at = now()
      where id = previous.id;
      target.supersedes_agreement_id := previous.id;
    end if;
  end if;

  update public.portal_brand_agreement
  set status = published_status,
      visibility = 'published',
      review_decision = 'approved',
      review_note = nullif(btrim(p_review_note), ''),
      brand_response_note = null,
      reviewed_by = p_actor_id,
      reviewed_by_email = nullif(btrim(p_actor_email), ''),
      reviewed_at = now(),
      published_by = p_actor_id,
      published_at = now(),
      archived_at = null,
      archived_by = null,
      supersedes_agreement_id = target.supersedes_agreement_id,
      updated_at = now()
  where id = target.id
  returning * into target;

  delete from public.portal_brand_agreement_renewal_notice
  where agreement_id = target.id;
  if target.expires_on is not null and published_status in ('active', 'expiring') then
    foreach reminder in array target.renewal_notice_days loop
      insert into public.portal_brand_agreement_renewal_notice (
        organization_id, agreement_id, reminder_days, remind_on,
        status, created_at, updated_at
      ) values (
        target.organization_id, target.id, reminder,
        target.expires_on - reminder, 'pending', now(), now()
      );
    end loop;
  end if;

  return target;
end;
$$;

revoke all on function public.portal_publish_brand_agreement(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.portal_publish_brand_agreement(uuid, uuid, text, text)
  to service_role;

comment on table public.portal_brand_agreement_document is
  'Immutable private Brand agreement PDFs retained only after a verified clean malware scan.';
comment on table public.portal_brand_agreement_renewal_notice is
  'Server-owned 90/60/30/0-day renewal schedule created when an agreement is published.';
