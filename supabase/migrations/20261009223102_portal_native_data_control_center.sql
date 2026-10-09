-- Portal-native data stewardship for Canix overlays, item identity, inbound
-- lots, Cost Objects, and catalog readiness. Canix remains read-only: these
-- decisions never mutate Canix and are reapplied to every fresh source sync.

create table if not exists public.portal_canix_owner_mapping (
  canix_owner_id bigint primary key,
  canix_owner_name text,
  economic_party_id uuid references public.portal_economic_party(id) on delete restrict,
  ownership_code text check (ownership_code is null or ownership_code in ('UX','TOLL','SPLIT','TEST')),
  decision_status text not null default 'pending_review'
    check (decision_status in ('pending_review','approved','conflict','not_required','archived')),
  decision_note text not null default '',
  source_system text not null default 'portal' check (source_system in ('portal','monday_import','manual_import')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (canix_owner_id > 0),
  check (decision_status <> 'approved' or ownership_code is not null)
);

create table if not exists public.portal_package_lot_overlay (
  canix_package_id bigint primary key,
  compliance_tag text,
  lot_id text,
  decision_status text not null default 'pending_review'
    check (decision_status in ('pending_review','approved','conflict','not_required','archived')),
  decision_note text not null default '',
  source_system text not null default 'portal' check (source_system in ('portal','monday_import','manual_import')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (canix_package_id > 0),
  check (lot_id is null or lot_id ~ '^[A-Z0-9-]{1,40}$'),
  check (
    (decision_status = 'approved' and lot_id is not null)
    or decision_status <> 'approved'
  )
);

create table if not exists public.portal_item_identity_mapping (
  canix_item_id bigint primary key,
  portal_sku_reference text,
  portal_sku_id uuid references public.portal_sku_intake(id) on delete set null,
  canix_item_name text,
  canix_brand_name text,
  decision_status text not null default 'pending_review'
    check (decision_status in ('pending_review','approved','conflict','not_required','archived')),
  decision_note text not null default '',
  source_system text not null default 'portal' check (source_system in ('portal','monday_import','manual_import')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (canix_item_id > 0),
  check (
    (decision_status = 'approved' and nullif(btrim(portal_sku_reference), '') is not null)
    or decision_status <> 'approved'
  )
);

create table if not exists public.portal_lot_register (
  lot_id text primary key check (lot_id ~ '^[A-Z0-9-]{1,40}$'),
  lot_name text not null,
  ownership_code text check (ownership_code is null or ownership_code in ('UX','TOLL','SPLIT','TEST')),
  canix_owner_id bigint,
  economic_party_id uuid references public.portal_economic_party(id) on delete restrict,
  agreement_reference text,
  deal_type text,
  uom_code text check (uom_code is null or uom_code in ('G_IN','G_OUT','G_DRY','G_WET')),
  expected_quantity numeric check (expected_quantity is null or expected_quantity >= 0),
  received_quantity numeric check (received_quantity is null or received_quantity >= 0),
  cost_object_candidate text,
  approval_status text not null default 'pending_review'
    check (approval_status in ('draft','pending_review','approved','rejected','conflict','archived')),
  source_system text not null default 'portal' check (source_system in ('portal','monday_import','manual_import')),
  source_record_id text,
  import_decision text check (import_decision is null or import_decision in ('auto_approved','review_required','manually_created')),
  decision_note text not null default '',
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  effective_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cost_object_candidate is null or cost_object_candidate ~ '^[A-Z0-9]+-[A-Z0-9]+(-[A-Z0-9]+)?$'),
  check (
    approval_status <> 'approved'
    or (ownership_code is not null and nullif(btrim(lot_name), '') is not null)
  )
);

create unique index if not exists portal_item_identity_mapping_sku_active_idx
  on public.portal_item_identity_mapping (upper(portal_sku_reference))
  where decision_status = 'approved' and portal_sku_reference is not null;
create index if not exists portal_owner_mapping_status_idx
  on public.portal_canix_owner_mapping (decision_status, updated_at desc);
create index if not exists portal_package_lot_overlay_lot_idx
  on public.portal_package_lot_overlay (lot_id, decision_status);
create index if not exists portal_item_identity_mapping_status_idx
  on public.portal_item_identity_mapping (decision_status, updated_at desc);
create index if not exists portal_lot_register_status_idx
  on public.portal_lot_register (approval_status, updated_at desc);

create table if not exists public.portal_data_control_event (
  id bigint generated always as identity primary key,
  control_type text not null check (control_type in ('owner_mapping','package_lot','item_mapping','lot_register','cost_object','catalog_record')),
  control_key text not null,
  action text not null check (action in ('created','approved','replaced','returned','conflict','not_required','archived','imported')),
  prior_state jsonb,
  current_state jsonb not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default now()
);
create index if not exists portal_data_control_event_lookup_idx
  on public.portal_data_control_event (control_type, control_key, created_at desc);

create or replace function public.portal_reject_data_control_event_mutation()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'Data-control decision history is append-only';
end;
$$;
drop trigger if exists portal_data_control_event_immutable on public.portal_data_control_event;
create trigger portal_data_control_event_immutable
before update or delete on public.portal_data_control_event
for each row execute function public.portal_reject_data_control_event_mutation();

-- Conservative one-time Monday import: only an approved row with a valid,
-- unique Lot ID, stable source ID, unchanged pointer, and complete ownership
-- classification becomes approved. Everything else enters review.
with source_rows as (
  select inbound.*,
    count(*) over (partition by nullif(upper(btrim(inbound.lot_id)), '')) as lot_count
  from public.portal_inbound_lot inbound
  where inbound.active
), prepared as (
  select
    upper(btrim(lot_id)) as canonical_lot_id,
    coalesce(nullif(btrim(monday_item_name), ''), 'Imported lot ' || monday_item_id) as lot_name,
    ownership_code,
    economic_partner,
    agreement_reference,
    deal_type,
    uom_code,
    expected_quantity,
    received_quantity,
    upper(nullif(btrim(cost_object_id), '')) as cost_object_candidate,
    monday_item_id,
    effective_date,
    case when
      nullif(btrim(monday_item_id), '') is not null
      and lot_id ~ '^[A-Z0-9-]{1,40}$'
      and lot_count = 1
      and not lot_id_change_detected
      and approval_status = 'approved'
      and ownership_code in ('UX','TOLL','SPLIT','TEST')
    then 'approved' else
      case when lot_count > 1 or lot_id_change_detected then 'conflict' else 'pending_review' end
    end as target_status,
    case when
      nullif(btrim(monday_item_id), '') is not null
      and lot_id ~ '^[A-Z0-9-]{1,40}$'
      and lot_count = 1
      and not lot_id_change_detected
      and approval_status = 'approved'
      and ownership_code in ('UX','TOLL','SPLIT','TEST')
    then 'auto_approved' else 'review_required' end as import_decision
  from source_rows
  where nullif(btrim(lot_id), '') is not null
)
insert into public.portal_lot_register (
  lot_id, lot_name, ownership_code, agreement_reference, deal_type, uom_code,
  expected_quantity, received_quantity, cost_object_candidate,
  approval_status, source_system, source_record_id, import_decision,
  decision_note, approved_by_email, approved_at, effective_date
)
select
  canonical_lot_id, lot_name, ownership_code, agreement_reference, deal_type,
  uom_code, expected_quantity, received_quantity, cost_object_candidate,
  target_status, 'monday_import', monday_item_id, import_decision,
  case when import_decision = 'auto_approved'
    then 'Imported from one unambiguous approved Monday record.'
    else 'Imported for Portal review; the source was incomplete, changed, duplicated, or not approved.' end,
  case when import_decision = 'auto_approved' then 'Historical Monday approval' end,
  case when import_decision = 'auto_approved' then now() end,
  effective_date
from prepared
on conflict (lot_id) do nothing;

insert into public.portal_data_control_event (
  control_type, control_key, action, current_state, actor_email
)
select 'lot_register', lot_id, 'imported', to_jsonb(lot_record), 'migration'
from public.portal_lot_register lot_record
where source_system = 'monday_import'
  and not exists (
    select 1 from public.portal_data_control_event event
    where event.control_type = 'lot_register'
      and event.control_key = lot_record.lot_id
      and event.action = 'imported'
  );

alter table public.portal_lot_cost_object_decision
  add column if not exists source_system text not null default 'portal',
  add column if not exists source_record_id text;
alter table public.portal_lot_cost_object_decision
  alter column monday_item_id drop not null;
update public.portal_lot_cost_object_decision
set source_record_id = coalesce(source_record_id, monday_item_id),
    source_system = case when monday_item_id is not null then 'monday_import' else 'portal' end
where source_record_id is null;

create or replace function public.portal_set_lot_cost_object_decision(
  p_lot_id text,
  p_decision_status text,
  p_cost_object_id text,
  p_decision_note text,
  p_actor_id uuid,
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_lot_id text := upper(nullif(btrim(p_lot_id), ''));
  normalized_status text := lower(nullif(btrim(p_decision_status), ''));
  normalized_cost_object text := upper(nullif(btrim(p_cost_object_id), ''));
  normalized_note text := nullif(btrim(p_decision_note), '');
  lot_row public.portal_lot_register%rowtype;
  prior public.portal_lot_cost_object_decision%rowtype;
  changed public.portal_lot_cost_object_decision%rowtype;
  can_decide boolean := false;
begin
  if normalized_lot_id is null or normalized_lot_id !~ '^[A-Z0-9-]{1,40}$' then
    raise exception 'A valid Lot ID is required';
  end if;
  if normalized_status not in ('pending_assignment','assigned','not_required') then
    raise exception 'Unsupported Cost Object decision status';
  end if;
  if normalized_note is null or length(normalized_note) < 8 then
    raise exception 'A decision note of at least 8 characters is required';
  end if;

  select exists (
    select 1 from public.portal_profile profile
    where profile.id = p_actor_id and profile.active and profile.role = 'internal'
      and (
        exists (
          select 1 from public.portal_role_permission permission
          where permission.staff_role = profile.staff_role
            and permission.permission = 'cost_objects.manage'
        )
        or exists (
          select 1 from public.portal_profile_department department
          where department.profile_id = profile.id
            and department.department_key = 'finance'
            and department.status = 'active'
        )
      )
  ) into can_decide;
  if not can_decide then raise exception 'Finance, Operations, or Administrator approval is required'; end if;

  select * into lot_row from public.portal_lot_register
  where lot_id = normalized_lot_id for update;
  if lot_row.lot_id is null then raise exception 'Lot ID must exist in the Portal lot register'; end if;
  if lot_row.approval_status <> 'approved' then raise exception 'The Portal lot record must be approved first'; end if;

  if normalized_status = 'assigned' then
    if normalized_cost_object is null or normalized_cost_object !~ '^[A-Z0-9]+-[A-Z0-9]+(-[A-Z0-9]+)?$' then
      raise exception 'Cost Object must use DEPT-LINE or DEPT-LINE-VARIANT';
    end if;
    if lot_row.cost_object_candidate is distinct from normalized_cost_object then
      raise exception 'The assigned code must exactly match the Portal lot-register value';
    end if;
  else
    normalized_cost_object := null;
  end if;

  select * into prior from public.portal_lot_cost_object_decision
  where lot_id = normalized_lot_id for update;

  insert into public.portal_lot_cost_object_decision (
    lot_id, monday_item_id, source_system, source_record_id,
    decision_status, cost_object_id, decision_note,
    decided_by, decided_by_email, decided_at, updated_at
  ) values (
    normalized_lot_id, null, 'portal', normalized_lot_id,
    normalized_status, normalized_cost_object, normalized_note,
    p_actor_id, nullif(btrim(p_actor_email), ''), now(), now()
  ) on conflict (lot_id) do update set
    monday_item_id = null,
    source_system = 'portal',
    source_record_id = excluded.source_record_id,
    decision_status = excluded.decision_status,
    cost_object_id = excluded.cost_object_id,
    decision_note = excluded.decision_note,
    decided_by = excluded.decided_by,
    decided_by_email = excluded.decided_by_email,
    decided_at = excluded.decided_at,
    updated_at = excluded.updated_at
  returning * into changed;

  insert into public.portal_lot_cost_object_event (
    lot_id, monday_item_id, prior_status, decision_status,
    prior_cost_object_id, cost_object_id, decision_note, actor_id, actor_email
  ) values (
    changed.lot_id, coalesce(changed.source_record_id, changed.lot_id),
    prior.decision_status, changed.decision_status, prior.cost_object_id,
    changed.cost_object_id, changed.decision_note, p_actor_id,
    nullif(btrim(p_actor_email), '')
  );
  insert into public.portal_data_control_event (
    control_type, control_key, action, prior_state, current_state, actor_id, actor_email
  ) values (
    'cost_object', changed.lot_id,
    case when changed.decision_status = 'not_required' then 'not_required'
      when prior.lot_id is null then 'approved' else 'replaced' end,
    case when prior.lot_id is null then null else to_jsonb(prior) end,
    to_jsonb(changed), p_actor_id, nullif(btrim(p_actor_email), '')
  );

  return jsonb_build_object(
    'lotId', changed.lot_id, 'status', changed.decision_status,
    'costObjectId', changed.cost_object_id, 'decisionNote', changed.decision_note,
    'decidedBy', changed.decided_by_email, 'decidedAt', changed.decided_at
  );
end;
$$;

alter table public.portal_canix_owner_mapping enable row level security;
alter table public.portal_package_lot_overlay enable row level security;
alter table public.portal_item_identity_mapping enable row level security;
alter table public.portal_lot_register enable row level security;
alter table public.portal_data_control_event enable row level security;

revoke all on table public.portal_canix_owner_mapping,
  public.portal_package_lot_overlay, public.portal_item_identity_mapping,
  public.portal_lot_register, public.portal_data_control_event
  from public, anon, authenticated;
grant all on table public.portal_canix_owner_mapping,
  public.portal_package_lot_overlay, public.portal_item_identity_mapping,
  public.portal_lot_register, public.portal_data_control_event
  to service_role;
grant usage, select on sequence public.portal_data_control_event_id_seq to service_role;
revoke all on function public.portal_reject_data_control_event_mutation() from public, anon, authenticated;
revoke all on function public.portal_set_lot_cost_object_decision(text,text,text,text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.portal_set_lot_cost_object_decision(text,text,text,text,uuid,text)
  to service_role;

comment on table public.portal_canix_owner_mapping is
  'Portal-only mapping of Canix operational Owner IDs to approved ownership classifications. Never written back to Canix.';
comment on table public.portal_package_lot_overlay is
  'Portal-only approved Lot ID overlay by immutable Canix package ID. Reused after each Canix snapshot.';
comment on table public.portal_item_identity_mapping is
  'Portal-owned durable Canix Item ID to UX OS SKU identity mapping.';
comment on table public.portal_lot_register is
  'Portal-owned inbound-lot authority. Monday rows are imported conservatively and retained as historical source evidence.';
comment on table public.portal_data_control_event is
  'Immutable history. A new approved mapping replaces the current mapping prospectively without erasing prior decisions.';
