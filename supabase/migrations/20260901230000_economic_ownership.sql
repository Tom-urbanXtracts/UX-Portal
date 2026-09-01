-- Brand identifies how an item is marketed. Canix Package Owner identifies the
-- Canix user operationally responsible for a package. Neither field establishes
-- which legal entity carries production economic risk, so UX OS owns that
-- classification until Canix exposes an approved organization-valued field.

alter table public.canix_package_current
  add column if not exists canix_package_owner_id bigint,
  add column if not exists canix_package_owner_name text;

-- owner_id / owner_name were previously populated from Brand. Clear that
-- incorrect alias and retain the nullable columns only for response compatibility
-- while clients move to the explicit fields below.
update public.canix_package_current
set owner_id = null,
    owner_name = null
where owner_id is not null or owner_name is not null;

drop index if exists public.canix_package_current_owner_idx;
create index if not exists canix_package_current_package_owner_idx
  on public.canix_package_current (canix_package_owner_id);

comment on column public.canix_package_current.owner_id is
  'Deprecated compatibility column. Must remain null; Brand and economic ownership are separate concepts.';
comment on column public.canix_package_current.owner_name is
  'Deprecated compatibility column. Must remain null; never fall back to Brand.';
comment on column public.canix_package_current.canix_package_owner_name is
  'Canix user assigned for operational package accountability when the API supplies it; not legal or economic ownership.';

create table if not exists public.portal_economic_party (
  id uuid primary key default gen_random_uuid(),
  party_code text not null unique,
  display_name text not null,
  legal_name text,
  party_type text not null check (party_type in (
    'urbanxtracts', 'brand_partner', 'contract_manufacturer', 'other'
  )),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (party_code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  check (length(btrim(display_name)) between 1 and 200)
);

insert into public.portal_economic_party (
  party_code, display_name, legal_name, party_type
) values (
  'URBANXTRACTS', 'urbanXtracts', 'urbanXtracts, LLC', 'urbanxtracts'
)
on conflict (party_code) do update set
  display_name = excluded.display_name,
  party_type = excluded.party_type,
  updated_at = now();

create table if not exists public.portal_inventory_ownership (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('item', 'package')),
  canix_item_id bigint,
  canix_package_id bigint,
  economic_owner_party_id uuid references public.portal_economic_party(id) on delete restrict,
  commercial_model text check (commercial_model is null or commercial_model in (
    'urbanxtracts_risk',
    'partner_owned',
    'backend_revenue_share',
    'toll_processing',
    'shared_risk',
    'unclassified'
  )),
  settlement_counterparty_party_id uuid references public.portal_economic_party(id) on delete restrict,
  source_system text not null default 'portal' check (source_system in (
    'portal', 'canix_custom_field', 'monday', 'manual_import'
  )),
  source_field text,
  note text,
  effective_from date not null default current_date,
  effective_to date,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope_type = 'item' and canix_item_id is not null and canix_package_id is null)
    or
    (scope_type = 'package' and canix_package_id is not null)
  ),
  check (effective_to is null or effective_to >= effective_from),
  check (source_system <> 'canix_custom_field' or nullif(btrim(source_field), '') is not null)
);

create unique index if not exists portal_inventory_ownership_current_item_idx
  on public.portal_inventory_ownership (canix_item_id)
  where scope_type = 'item' and effective_to is null;
create unique index if not exists portal_inventory_ownership_current_package_idx
  on public.portal_inventory_ownership (canix_package_id)
  where scope_type = 'package' and effective_to is null;
create index if not exists portal_inventory_ownership_owner_idx
  on public.portal_inventory_ownership (economic_owner_party_id)
  where effective_to is null;

create table if not exists public.portal_inventory_ownership_event (
  id bigint generated always as identity primary key,
  ownership_id uuid references public.portal_inventory_ownership(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null check (action in ('classified', 'reclassified', 'cleared')),
  scope_type text not null check (scope_type in ('item', 'package')),
  canix_item_id bigint,
  canix_package_id bigint,
  economic_owner_party_id uuid references public.portal_economic_party(id) on delete set null,
  commercial_model text,
  settlement_counterparty_party_id uuid references public.portal_economic_party(id) on delete set null,
  source_system text not null,
  source_field text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists portal_inventory_ownership_event_scope_idx
  on public.portal_inventory_ownership_event (canix_package_id, canix_item_id, created_at desc);

create or replace function public.portal_set_inventory_ownership(
  p_scope_type text,
  p_canix_item_id bigint,
  p_canix_package_id bigint,
  p_economic_owner_party_id uuid,
  p_commercial_model text,
  p_settlement_counterparty_party_id uuid,
  p_source_system text,
  p_source_field text,
  p_note text,
  p_actor_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prior public.portal_inventory_ownership%rowtype;
  changed public.portal_inventory_ownership%rowtype;
  event_action text;
begin
  if p_scope_type not in ('item', 'package') then raise exception 'Unsupported ownership scope'; end if;
  if p_scope_type = 'item' and (p_canix_item_id is null or p_canix_package_id is not null) then
    raise exception 'Item ownership requires only a Canix item id';
  end if;
  if p_scope_type = 'package' and p_canix_package_id is null then
    raise exception 'Package ownership requires a Canix package id';
  end if;
  if p_commercial_model is not null and p_commercial_model not in (
    'urbanxtracts_risk', 'partner_owned', 'backend_revenue_share',
    'toll_processing', 'shared_risk', 'unclassified'
  ) then raise exception 'Unsupported commercial model'; end if;
  if p_source_system not in ('portal', 'canix_custom_field', 'monday', 'manual_import') then
    raise exception 'Unsupported ownership source';
  end if;
  if p_source_system = 'canix_custom_field' and nullif(btrim(p_source_field), '') is null then
    raise exception 'A Canix source field is required';
  end if;

  if p_scope_type = 'item' then
    select * into prior from public.portal_inventory_ownership
    where scope_type = 'item' and canix_item_id = p_canix_item_id and effective_to is null
    for update;
  else
    select * into prior from public.portal_inventory_ownership
    where scope_type = 'package' and canix_package_id = p_canix_package_id and effective_to is null
    for update;
  end if;

  if prior.id is not null then
    update public.portal_inventory_ownership
    set effective_to = current_date,
        updated_by = p_actor_id,
        updated_at = now()
    where id = prior.id;
  end if;

  insert into public.portal_inventory_ownership (
    scope_type, canix_item_id, canix_package_id,
    economic_owner_party_id, commercial_model, settlement_counterparty_party_id,
    source_system, source_field, note, created_by, updated_by
  ) values (
    p_scope_type, p_canix_item_id, p_canix_package_id,
    p_economic_owner_party_id, p_commercial_model, p_settlement_counterparty_party_id,
    p_source_system, nullif(btrim(p_source_field), ''), nullif(btrim(p_note), ''), p_actor_id, p_actor_id
  ) returning * into changed;

  event_action := case
    when p_economic_owner_party_id is null and p_commercial_model is null and p_settlement_counterparty_party_id is null then 'cleared'
    when prior.id is null then 'classified'
    else 'reclassified'
  end;

  insert into public.portal_inventory_ownership_event (
    ownership_id, actor_id, actor_email, action, scope_type,
    canix_item_id, canix_package_id, economic_owner_party_id, commercial_model,
    settlement_counterparty_party_id, source_system, source_field, note
  ) values (
    changed.id, p_actor_id, p_actor_email, event_action, p_scope_type,
    p_canix_item_id, p_canix_package_id, p_economic_owner_party_id, p_commercial_model,
    p_settlement_counterparty_party_id, p_source_system,
    nullif(btrim(p_source_field), ''), nullif(btrim(p_note), '')
  );

  return to_jsonb(changed);
end;
$$;

alter table public.portal_economic_party enable row level security;
alter table public.portal_inventory_ownership enable row level security;
alter table public.portal_inventory_ownership_event enable row level security;

revoke all on table public.portal_economic_party from anon, authenticated;
revoke all on table public.portal_inventory_ownership from anon, authenticated;
revoke all on table public.portal_inventory_ownership_event from anon, authenticated;
grant all on table public.portal_economic_party to service_role;
grant all on table public.portal_inventory_ownership to service_role;
grant all on table public.portal_inventory_ownership_event to service_role;
grant usage, select on sequence public.portal_inventory_ownership_event_id_seq to service_role;
revoke all on function public.portal_set_inventory_ownership(text, bigint, bigint, uuid, text, uuid, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.portal_set_inventory_ownership(text, bigint, bigint, uuid, text, uuid, text, text, text, uuid, text) to service_role;

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
    'financials.read',
    'economics.manage',
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
  ('administrator', 'economics.manage'),
  ('operations', 'economics.manage'),
  ('sales', 'economics.manage')
on conflict do nothing;

comment on table public.portal_economic_party is
  'Internal organizations that may carry economic risk or receive settlement; never inferred from Canix Brand.';
comment on table public.portal_inventory_ownership is
  'Effective-dated economic ownership defaults by Canix item with optional package override. A blank owner is valid and remains visibly unclassified.';
comment on column public.portal_inventory_ownership.commercial_model is
  'Commercial risk arrangement. backend_revenue_share means urbanXtracts may carry production risk while a separate party participates in settlement.';
comment on column public.portal_inventory_ownership.source_field is
  'Exact Canix API/custom field name only after Canix confirms a supported economic-owner source; otherwise blank.';
