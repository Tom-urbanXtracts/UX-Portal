-- Keep product merchandising content separate from Canix inventory facts.
-- Canix remains authoritative for packages, release state and lab/COA data;
-- Monday remains authoritative for descriptive product content.

alter table public.canix_package_current
  add column if not exists coa_url text,
  add column if not exists coa_document_id text,
  add column if not exists lab_name text,
  add column if not exists lab_tested_at timestamptz,
  add column if not exists lab_batch_number text,
  add column if not exists cannabinoids jsonb not null default '[]'::jsonb,
  add column if not exists terpenes jsonb not null default '[]'::jsonb,
  add column if not exists lab_profile jsonb not null default '{}'::jsonb,
  add column if not exists source_package_ids bigint[] not null default '{}'::bigint[];

alter table public.canix_package_current
  drop constraint if exists canix_package_current_cannabinoids_check,
  drop constraint if exists canix_package_current_terpenes_check,
  drop constraint if exists canix_package_current_lab_profile_check;

alter table public.canix_package_current
  add constraint canix_package_current_cannabinoids_check
    check (jsonb_typeof(cannabinoids) = 'array') not valid,
  add constraint canix_package_current_terpenes_check
    check (jsonb_typeof(terpenes) = 'array') not valid,
  add constraint canix_package_current_lab_profile_check
    check (jsonb_typeof(lab_profile) = 'object') not valid;

alter table public.canix_package_current
  validate constraint canix_package_current_cannabinoids_check;
alter table public.canix_package_current
  validate constraint canix_package_current_terpenes_check;
alter table public.canix_package_current
  validate constraint canix_package_current_lab_profile_check;

create index if not exists canix_package_current_source_packages_idx
  on public.canix_package_current using gin (source_package_ids);

create table if not exists public.canix_package_coa (
  package_id bigint primary key references public.canix_package_current(package_id) on delete cascade,
  canix_item_id bigint,
  compliance_tag text,
  document_url text,
  source_document_id text,
  version integer not null default 1 check (version > 0),
  lab_name text,
  batch_number text,
  tested_at timestamptz,
  result_status text,
  cannabinoids jsonb not null default '[]'::jsonb check (jsonb_typeof(cannabinoids) = 'array'),
  terpenes jsonb not null default '[]'::jsonb check (jsonb_typeof(terpenes) = 'array'),
  profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object'),
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists canix_package_coa_item_idx
  on public.canix_package_coa (canix_item_id);
create index if not exists canix_package_coa_tag_idx
  on public.canix_package_coa (compliance_tag);
create index if not exists canix_package_coa_tested_idx
  on public.canix_package_coa (tested_at desc);

create table if not exists public.canix_package_coa_history (
  id bigint generated always as identity primary key,
  package_id bigint not null,
  version integer not null check (version > 0),
  canix_item_id bigint,
  compliance_tag text,
  document_url text,
  source_document_id text,
  lab_name text,
  batch_number text,
  tested_at timestamptz,
  result_status text,
  cannabinoids jsonb not null default '[]'::jsonb check (jsonb_typeof(cannabinoids) = 'array'),
  terpenes jsonb not null default '[]'::jsonb check (jsonb_typeof(terpenes) = 'array'),
  profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object'),
  source_updated_at timestamptz,
  synced_at timestamptz not null,
  archived_at timestamptz not null default now(),
  unique (package_id, version)
);

create or replace function public.canix_preserve_coa_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if row(
    new.document_url, new.source_document_id, new.lab_name, new.batch_number,
    new.tested_at, new.result_status, new.cannabinoids, new.terpenes, new.profile
  ) is distinct from row(
    old.document_url, old.source_document_id, old.lab_name, old.batch_number,
    old.tested_at, old.result_status, old.cannabinoids, old.terpenes, old.profile
  ) then
    insert into public.canix_package_coa_history (
      package_id, version, canix_item_id, compliance_tag, document_url,
      source_document_id, lab_name, batch_number, tested_at, result_status,
      cannabinoids, terpenes, profile, source_updated_at, synced_at
    ) values (
      old.package_id, old.version, old.canix_item_id, old.compliance_tag,
      old.document_url, old.source_document_id, old.lab_name, old.batch_number,
      old.tested_at, old.result_status, old.cannabinoids, old.terpenes,
      old.profile, old.source_updated_at, old.synced_at
    ) on conflict (package_id, version) do nothing;
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

drop trigger if exists canix_package_coa_revision on public.canix_package_coa;
create trigger canix_package_coa_revision
before update on public.canix_package_coa
for each row execute function public.canix_preserve_coa_revision();

revoke all on function public.canix_preserve_coa_revision() from public, anon, authenticated;

create table if not exists public.portal_product_content (
  canix_item_id bigint primary key,
  monday_item_id text,
  monday_board_id text,
  publication_state text not null default 'draft'
    check (publication_state in ('draft', 'published', 'archived')),
  short_description text,
  long_description text,
  selling_points text[] not null default '{}'::text[],
  ingredients text,
  usage_information text,
  product_profile text,
  image_url text,
  keywords text[] not null default '{}'::text[],
  source_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists portal_product_content_state_idx
  on public.portal_product_content (publication_state, updated_at desc);
create index if not exists portal_product_content_monday_idx
  on public.portal_product_content (monday_item_id);
create unique index if not exists portal_product_content_monday_source_idx
  on public.portal_product_content (monday_board_id, monday_item_id)
  where monday_board_id is not null and monday_item_id is not null;

create table if not exists public.portal_product_content_event (
  id bigint generated always as identity primary key,
  canix_item_id bigint not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  source text not null check (source in ('monday', 'internal', 'system')),
  action text not null check (action in ('created', 'updated', 'published', 'archived')),
  publication_state text not null check (publication_state in ('draft', 'published', 'archived')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portal_product_content_event_item_idx
  on public.portal_product_content_event (canix_item_id, created_at desc);

create or replace function public.portal_upsert_product_content(
  p_canix_item_id bigint,
  p_monday_item_id text,
  p_monday_board_id text,
  p_publication_state text,
  p_short_description text,
  p_long_description text,
  p_selling_points text[],
  p_ingredients text,
  p_usage_information text,
  p_product_profile text,
  p_image_url text,
  p_keywords text[],
  p_source_updated_at timestamptz,
  p_actor_id uuid,
  p_actor_email text,
  p_source text,
  p_action text,
  p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed public.portal_product_content%rowtype;
begin
  if p_source not in ('monday', 'internal', 'system') then raise exception 'Unsupported product-content source'; end if;
  if p_action not in ('created', 'updated', 'published', 'archived') then raise exception 'Unsupported product-content action'; end if;
  if p_publication_state not in ('draft', 'published', 'archived') then raise exception 'Unsupported publication state'; end if;

  insert into public.portal_product_content (
    canix_item_id, monday_item_id, monday_board_id, publication_state,
    short_description, long_description, selling_points, ingredients,
    usage_information, product_profile, image_url, keywords,
    source_updated_at, last_synced_at, updated_by, updated_by_email, updated_at
  ) values (
    p_canix_item_id, p_monday_item_id, p_monday_board_id, p_publication_state,
    p_short_description, p_long_description, coalesce(p_selling_points, '{}'::text[]), p_ingredients,
    p_usage_information, p_product_profile, p_image_url, coalesce(p_keywords, '{}'::text[]),
    p_source_updated_at, now(), p_actor_id, p_actor_email, now()
  )
  on conflict (canix_item_id) do update set
    monday_item_id = excluded.monday_item_id,
    monday_board_id = excluded.monday_board_id,
    publication_state = excluded.publication_state,
    short_description = excluded.short_description,
    long_description = excluded.long_description,
    selling_points = excluded.selling_points,
    ingredients = excluded.ingredients,
    usage_information = excluded.usage_information,
    product_profile = excluded.product_profile,
    image_url = excluded.image_url,
    keywords = excluded.keywords,
    source_updated_at = excluded.source_updated_at,
    last_synced_at = excluded.last_synced_at,
    updated_by = excluded.updated_by,
    updated_by_email = excluded.updated_by_email,
    updated_at = excluded.updated_at
  returning * into changed;

  insert into public.portal_product_content_event (
    canix_item_id, actor_id, actor_email, source, action, publication_state, detail
  ) values (
    p_canix_item_id, p_actor_id, p_actor_email, p_source, p_action,
    p_publication_state, coalesce(p_detail, '{}'::jsonb)
  );

  return to_jsonb(changed);
end;
$$;

alter table public.canix_package_coa enable row level security;
alter table public.canix_package_coa_history enable row level security;
alter table public.portal_product_content enable row level security;
alter table public.portal_product_content_event enable row level security;

revoke all on table public.canix_package_coa from anon, authenticated;
revoke all on table public.canix_package_coa_history from anon, authenticated;
revoke all on table public.portal_product_content from anon, authenticated;
revoke all on table public.portal_product_content_event from anon, authenticated;
grant all on table public.canix_package_coa to service_role;
grant all on table public.canix_package_coa_history to service_role;
grant all on table public.portal_product_content to service_role;
grant all on table public.portal_product_content_event to service_role;
grant usage, select on sequence public.canix_package_coa_history_id_seq to service_role;
grant usage, select on sequence public.portal_product_content_event_id_seq to service_role;
revoke all on function public.portal_upsert_product_content(bigint, text, text, text, text, text, text[], text, text, text, text, text[], timestamptz, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.portal_upsert_product_content(bigint, text, text, text, text, text, text[], text, text, text, text, text[], timestamptz, uuid, text, text, text, jsonb) to service_role;

alter table public.portal_role_permission
  drop constraint if exists portal_role_permission_permission_check;

alter table public.portal_role_permission
  add constraint portal_role_permission_permission_check
  check (permission in (
    'inventory.read',
    'inventory.sync',
    'orders.manage',
    'accounts.manage',
    'pricing.manage',
    'catalog.manage',
    'quality.manage',
    'lineage.read',
    'users.manage',
    'audit.read',
    'readiness.read'
  )) not valid;

alter table public.portal_role_permission
  validate constraint portal_role_permission_permission_check;

insert into public.portal_role_permission (staff_role, permission)
values
  ('administrator', 'catalog.manage'),
  ('operations', 'catalog.manage'),
  ('sales', 'catalog.manage')
on conflict do nothing;

comment on table public.portal_product_content is
  'Monday-backed merchandising content keyed to a Canix item. Product identity and inventory remain authoritative in Canix.';
comment on table public.canix_package_coa is
  'Current normalized Canix COA and lab projection per package. Browser roles have no direct table access.';
comment on table public.canix_package_coa_history is
  'Immutable prior normalized COA revisions preserved when Canix changes the current record.';
comment on column public.canix_package_current.source_package_ids is
  'Parent/source package identifiers only when they are explicitly supplied by Canix; otherwise an empty array.';
