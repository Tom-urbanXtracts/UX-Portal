-- Keep economic ownership in the Monday inbound-lot register while Canix
-- carries only a non-disclosing lot_id pointer. Enforcement starts in monitor
-- mode so historical gaps are visible without unexpectedly freezing inventory.

alter table public.canix_package_current
  add column if not exists lot_id text,
  add column if not exists production_batch_number text;

alter table public.canix_package_sync_stage
  add column if not exists lot_id text,
  add column if not exists production_batch_number text;

create index if not exists canix_package_current_lot_idx
  on public.canix_package_current (lot_id)
  where nullif(btrim(lot_id), '') is not null;

comment on column public.canix_package_current.lot_id is
  'Free-form Canix-only package lot pointer. Economic ownership is resolved from the protected Monday lot register and is never stored in Canix Brand.';
comment on column public.canix_package_current.production_batch_number is
  'Canix production-batch identifier, retained separately from the internal lot pointer.';

create table if not exists public.portal_inbound_lot (
  monday_item_id text primary key,
  monday_board_id text not null,
  monday_item_name text not null,
  source_lot_id text,
  lot_id text,
  lot_id_locked_at timestamptz,
  lot_id_change_detected boolean not null default false,
  lot_id_change_detail text,
  ownership_code text check (ownership_code is null or ownership_code in ('UX', 'TOLL', 'SPLIT', 'TEST')),
  partner_id text,
  economic_partner text,
  agreement_reference text,
  deal_type text,
  pricing_basis text,
  settlement_trigger text,
  split_terms text,
  expected_quantity numeric check (expected_quantity is null or expected_quantity >= 0),
  uom_code text check (uom_code is null or uom_code in ('G_IN', 'G_OUT', 'G_DRY', 'G_WET')),
  received_quantity numeric check (received_quantity is null or received_quantity >= 0),
  metrc_transfer_reference text,
  canix_package_references text,
  cost_object_id text,
  approval_status text check (approval_status is null or approval_status in ('draft', 'pending_review', 'approved', 'rejected', 'closed')),
  approved_by text,
  effective_date date,
  approval_date date,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  active boolean not null default true,
  raw_payload jsonb not null default '{}'::jsonb
);

create index if not exists portal_inbound_lot_lookup_idx
  on public.portal_inbound_lot (lot_id)
  where active and lot_id is not null;
create index if not exists portal_inbound_lot_approval_idx
  on public.portal_inbound_lot (approval_status, active);

create table if not exists public.portal_package_lot_control (
  package_id bigint primary key references public.canix_package_current(package_id) on delete cascade,
  sync_run_id uuid not null,
  lot_id text,
  integrity_status text not null check (integrity_status in (
    'valid', 'missing_pointer', 'multiple_lots', 'format_error',
    'unknown_lot', 'duplicate_register_lot', 'register_lock_violation',
    'unapproved_lot'
  )),
  allocation_eligible boolean not null default false,
  detail text not null,
  checked_at timestamptz not null default now()
);

create index if not exists portal_package_lot_control_status_idx
  on public.portal_package_lot_control (integrity_status, allocation_eligible);

create table if not exists public.portal_lot_integrity_state (
  id smallint primary key default 1 check (id = 1),
  monday_board_id text not null default '18429359264',
  enforcement_mode text not null default 'monitor'
    check (enforcement_mode in ('monitor', 'block')),
  register_sync_status text not null default 'never_run'
    check (register_sync_status in ('never_run', 'running', 'success', 'error')),
  last_register_sync_at timestamptz,
  last_integrity_run_at timestamptz,
  last_error text,
  register_rows integer not null default 0,
  approved_register_rows integer not null default 0,
  invalid_register_rows integer not null default 0,
  duplicate_register_rows integer not null default 0,
  package_rows integer not null default 0,
  valid_package_rows integer not null default 0,
  exception_package_rows integer not null default 0,
  allocation_exception_rows integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.portal_lot_integrity_state (id)
values (1)
on conflict (id) do nothing;

alter table public.portal_inbound_lot enable row level security;
alter table public.portal_package_lot_control enable row level security;
alter table public.portal_lot_integrity_state enable row level security;

revoke all on table public.portal_inbound_lot from public, anon, authenticated;
revoke all on table public.portal_package_lot_control from public, anon, authenticated;
revoke all on table public.portal_lot_integrity_state from public, anon, authenticated;
grant all on table public.portal_inbound_lot to service_role;
grant all on table public.portal_package_lot_control to service_role;
grant all on table public.portal_lot_integrity_state to service_role;

create or replace function public.portal_reconcile_lot_integrity()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  with register_summary as (
    select
      lot_id,
      count(*)::integer as row_count,
      bool_or(lot_id_change_detected) as has_lock_violation,
      bool_and(coalesce(approval_status = 'approved', false)) as approved
    from public.portal_inbound_lot
    where active and lot_id is not null
    group by lot_id
  ), evaluated as (
    select
      package.package_id,
      package.sync_run_id,
      nullif(btrim(package.lot_id), '') as lot_id,
      case
        when nullif(btrim(package.lot_id), '') is null then 'missing_pointer'
        when position(',' in package.lot_id) > 0 then 'multiple_lots'
        when btrim(package.lot_id) !~ '^[A-Z0-9-]{1,20}$' then 'format_error'
        when register.lot_id is null then 'unknown_lot'
        when register.row_count > 1 then 'duplicate_register_lot'
        when register.has_lock_violation then 'register_lock_violation'
        when not register.approved then 'unapproved_lot'
        else 'valid'
      end as integrity_status,
      case
        when nullif(btrim(package.lot_id), '') is null then 'Canix package has no lot_id pointer.'
        when position(',' in package.lot_id) > 0 then 'Canix package contains multiple comma-separated lot values; one package must point to one lot.'
        when btrim(package.lot_id) !~ '^[A-Z0-9-]{1,20}$' then 'Canix lot_id does not satisfy the uppercase/hyphenated 20-character contract.'
        when register.lot_id is null then 'Canix lot_id is not present in the active Monday inbound-lot register.'
        when register.row_count > 1 then 'More than one active Monday lot record uses this lot_id.'
        when register.has_lock_violation then 'The Monday Lot ID changed after approval; the protected portal value remained locked.'
        when not register.approved then 'The matching Monday lot record is not approved.'
        else 'Canix lot_id resolves to one approved, unchanged Monday lot record.'
      end as detail
    from public.canix_package_current package
    left join register_summary register
      on register.lot_id = nullif(btrim(package.lot_id), '')
  )
  insert into public.portal_package_lot_control (
    package_id, sync_run_id, lot_id, integrity_status,
    allocation_eligible, detail, checked_at
  )
  select
    package_id, sync_run_id, lot_id, integrity_status,
    integrity_status = 'valid', detail, now()
  from evaluated
  on conflict (package_id) do update
  set sync_run_id = excluded.sync_run_id,
      lot_id = excluded.lot_id,
      integrity_status = excluded.integrity_status,
      allocation_eligible = excluded.allocation_eligible,
      detail = excluded.detail,
      checked_at = excluded.checked_at;

  delete from public.portal_package_lot_control control
  where not exists (
    select 1 from public.canix_package_current package
    where package.package_id = control.package_id
  );

  with register_counts as (
    select
      count(*) filter (where active)::integer as rows,
      count(*) filter (where active and approval_status = 'approved')::integer as approved,
      count(*) filter (
        where active and (
          source_lot_id is null
          or source_lot_id !~ '^[A-Z0-9-]{1,20}$'
          or lot_id_change_detected
        )
      )::integer as invalid
    from public.portal_inbound_lot
  ), duplicate_counts as (
    select coalesce(sum(row_count), 0)::integer as rows
    from (
      select count(*)::integer as row_count
      from public.portal_inbound_lot
      where active and lot_id is not null
      group by lot_id
      having count(*) > 1
    ) duplicates
  ), package_counts as (
    select
      count(*)::integer as rows,
      count(*) filter (where control.integrity_status = 'valid')::integer as valid,
      count(*) filter (where control.integrity_status <> 'valid')::integer as exceptions,
      count(*) filter (
        where control.integrity_status <> 'valid'
          and package.status_category in ('available', 'allocated')
      )::integer as allocation_exceptions
    from public.portal_package_lot_control control
    join public.canix_package_current package using (package_id)
  )
  update public.portal_lot_integrity_state state
  set last_integrity_run_at = now(),
      register_rows = register_counts.rows,
      approved_register_rows = register_counts.approved,
      invalid_register_rows = register_counts.invalid,
      duplicate_register_rows = duplicate_counts.rows,
      package_rows = package_counts.rows,
      valid_package_rows = package_counts.valid,
      exception_package_rows = package_counts.exceptions,
      allocation_exception_rows = package_counts.allocation_exceptions,
      last_error = null,
      updated_at = now()
  from register_counts, duplicate_counts, package_counts
  where state.id = 1;

  select jsonb_build_object(
    'enforcementMode', enforcement_mode,
    'registerRows', register_rows,
    'approvedRegisterRows', approved_register_rows,
    'invalidRegisterRows', invalid_register_rows,
    'duplicateRegisterRows', duplicate_register_rows,
    'packageRows', package_rows,
    'validPackageRows', valid_package_rows,
    'exceptionPackageRows', exception_package_rows,
    'allocationExceptionRows', allocation_exception_rows,
    'checkedAt', last_integrity_run_at
  ) into result
  from public.portal_lot_integrity_state
  where id = 1;

  return result;
end;
$$;

-- Keep the package decision in the same database transaction as snapshot
-- publication. This prevents block mode from briefly observing a new Canix
-- run with controls from the prior run.
create or replace function public.portal_reconcile_lots_after_canix_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'success' and new.last_successful_run_id is distinct from old.last_successful_run_id then
    perform public.portal_reconcile_lot_integrity();
  end if;
  return new;
end;
$$;

drop trigger if exists portal_reconcile_lots_after_canix_publish
  on public.canix_sync_state;
create trigger portal_reconcile_lots_after_canix_publish
after update of last_successful_run_id on public.canix_sync_state
for each row execute function public.portal_reconcile_lots_after_canix_publish();

create or replace function public.portal_publish_monday_lots(
  p_board_id text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  published_count integer;
  result jsonb;
begin
  if p_board_id is null or p_board_id <> (
    select monday_board_id from public.portal_lot_integrity_state where id = 1
  ) then
    raise exception 'Unexpected Monday lot-register board';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10000 then
    raise exception 'Invalid Monday lot-register snapshot';
  end if;

  update public.portal_lot_integrity_state
  set register_sync_status = 'running', last_error = null, updated_at = now()
  where id = 1;

  create temporary table incoming_lots (
    monday_item_id text primary key,
    monday_item_name text not null,
    source_lot_id text,
    ownership_code text,
    partner_id text,
    economic_partner text,
    agreement_reference text,
    deal_type text,
    pricing_basis text,
    settlement_trigger text,
    split_terms text,
    expected_quantity numeric,
    uom_code text,
    received_quantity numeric,
    metrc_transfer_reference text,
    canix_package_references text,
    cost_object_id text,
    approval_status text,
    approved_by text,
    effective_date date,
    approval_date date,
    source_updated_at timestamptz,
    raw_payload jsonb
  ) on commit drop;

  insert into incoming_lots
  select
    left(nullif(btrim(row.monday_item_id), ''), 80),
    left(coalesce(nullif(btrim(row.monday_item_name), ''), 'Unnamed Monday lot'), 255),
    left(nullif(btrim(row.source_lot_id), ''), 200),
    case when upper(btrim(row.ownership_code)) in ('UX', 'TOLL', 'SPLIT', 'TEST') then upper(btrim(row.ownership_code)) end,
    left(nullif(btrim(row.partner_id), ''), 200),
    left(nullif(btrim(row.economic_partner), ''), 300),
    left(nullif(btrim(row.agreement_reference), ''), 500),
    left(nullif(btrim(row.deal_type), ''), 120),
    left(nullif(btrim(row.pricing_basis), ''), 500),
    left(nullif(btrim(row.settlement_trigger), ''), 500),
    left(nullif(btrim(row.split_terms), ''), 4000),
    case when row.expected_quantity >= 0 then row.expected_quantity end,
    case when upper(btrim(row.uom_code)) in ('G_IN', 'G_OUT', 'G_DRY', 'G_WET') then upper(btrim(row.uom_code)) end,
    case when row.received_quantity >= 0 then row.received_quantity end,
    left(nullif(btrim(row.metrc_transfer_reference), ''), 500),
    left(nullif(btrim(row.canix_package_references), ''), 10000),
    left(nullif(btrim(row.cost_object_id), ''), 200),
    case lower(btrim(row.approval_status))
      when 'draft' then 'draft'
      when 'pending review' then 'pending_review'
      when 'approved' then 'approved'
      when 'rejected' then 'rejected'
      when 'closed' then 'closed'
    end,
    left(nullif(btrim(row.approved_by), ''), 500),
    row.effective_date,
    row.approval_date,
    row.source_updated_at,
    coalesce(row.raw_payload, '{}'::jsonb)
  from jsonb_to_recordset(p_rows) as row(
    monday_item_id text,
    monday_item_name text,
    source_lot_id text,
    ownership_code text,
    partner_id text,
    economic_partner text,
    agreement_reference text,
    deal_type text,
    pricing_basis text,
    settlement_trigger text,
    split_terms text,
    expected_quantity numeric,
    uom_code text,
    received_quantity numeric,
    metrc_transfer_reference text,
    canix_package_references text,
    cost_object_id text,
    approval_status text,
    approved_by text,
    effective_date date,
    approval_date date,
    source_updated_at timestamptz,
    raw_payload jsonb
  )
  where nullif(btrim(row.monday_item_id), '') is not null;

  insert into public.portal_inbound_lot as target (
    monday_item_id, monday_board_id, monday_item_name,
    source_lot_id, lot_id, lot_id_locked_at,
    ownership_code, partner_id, economic_partner, agreement_reference,
    deal_type, pricing_basis, settlement_trigger, split_terms,
    expected_quantity, uom_code, received_quantity,
    metrc_transfer_reference, canix_package_references, cost_object_id,
    approval_status, approved_by, effective_date, approval_date,
    source_updated_at, synced_at, active, raw_payload
  )
  select
    monday_item_id, p_board_id, monday_item_name,
    source_lot_id, source_lot_id,
    case when approval_status = 'approved' and source_lot_id ~ '^[A-Z0-9-]{1,20}$' then now() end,
    ownership_code, partner_id, economic_partner, agreement_reference,
    deal_type, pricing_basis, settlement_trigger, split_terms,
    expected_quantity, uom_code, received_quantity,
    metrc_transfer_reference, canix_package_references, cost_object_id,
    approval_status, approved_by, effective_date, approval_date,
    source_updated_at, now(), true, raw_payload
  from incoming_lots
  on conflict (monday_item_id) do update
  set monday_board_id = excluded.monday_board_id,
      monday_item_name = excluded.monday_item_name,
      source_lot_id = excluded.source_lot_id,
      lot_id = case
        when target.lot_id_locked_at is not null then target.lot_id
        else excluded.lot_id
      end,
      lot_id_locked_at = case
        when target.lot_id_locked_at is not null then target.lot_id_locked_at
        when excluded.approval_status = 'approved'
          and excluded.lot_id ~ '^[A-Z0-9-]{1,20}$' then now()
        else null
      end,
      lot_id_change_detected = case
        when target.lot_id_locked_at is not null
          then excluded.source_lot_id is distinct from target.lot_id
        else false
      end,
      lot_id_change_detail = case
        when target.lot_id_locked_at is not null
          and excluded.source_lot_id is distinct from target.lot_id
          then 'Monday Lot ID changed after approval; protected value remains ' || coalesce(target.lot_id, '(blank)') || '.'
        else null
      end,
      ownership_code = excluded.ownership_code,
      partner_id = excluded.partner_id,
      economic_partner = excluded.economic_partner,
      agreement_reference = excluded.agreement_reference,
      deal_type = excluded.deal_type,
      pricing_basis = excluded.pricing_basis,
      settlement_trigger = excluded.settlement_trigger,
      split_terms = excluded.split_terms,
      expected_quantity = excluded.expected_quantity,
      uom_code = excluded.uom_code,
      received_quantity = excluded.received_quantity,
      metrc_transfer_reference = excluded.metrc_transfer_reference,
      canix_package_references = excluded.canix_package_references,
      cost_object_id = excluded.cost_object_id,
      approval_status = excluded.approval_status,
      approved_by = excluded.approved_by,
      effective_date = excluded.effective_date,
      approval_date = excluded.approval_date,
      source_updated_at = excluded.source_updated_at,
      synced_at = now(),
      active = true,
      raw_payload = excluded.raw_payload;

  update public.portal_inbound_lot lot
  set active = false, synced_at = now()
  where lot.monday_board_id = p_board_id
    and lot.active
    and not exists (
      select 1 from incoming_lots incoming
      where incoming.monday_item_id = lot.monday_item_id
    );

  select count(*)::integer into published_count from incoming_lots;
  update public.portal_lot_integrity_state
  set register_sync_status = 'success',
      last_register_sync_at = now(),
      last_error = null,
      updated_at = now()
  where id = 1;

  result := public.portal_reconcile_lot_integrity();
  return result || jsonb_build_object('publishedRows', published_count, 'boardId', p_board_id);
exception when others then
  update public.portal_lot_integrity_state
  set register_sync_status = 'error',
      last_error = left(sqlerrm, 1000),
      updated_at = now()
  where id = 1;
  raise;
end;
$$;

create or replace function public.portal_set_lot_integrity_mode(p_mode text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_mode not in ('monitor', 'block') then
    raise exception 'Unsupported lot-integrity enforcement mode';
  end if;
  update public.portal_lot_integrity_state
  set enforcement_mode = p_mode, updated_at = now()
  where id = 1;
  return p_mode;
end;
$$;

-- Order inventory checks are mode-aware now, but monitor remains the default.
-- Changing to block later requires an explicit service-role action after the
-- missing and malformed historical pointers have been reconciled.
create or replace function public.portal_commit_order_line_inventory()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_run_id uuid;
  item_id_value bigint;
  available_units numeric;
  already_committed numeric;
  enforcement_mode_value text;
  line_group record;
begin
  if exists (
    select 1 from inserted_lines
    where unit <> 'each' or product_id !~ '^canix:item:[1-9][0-9]*$'
  ) then
    raise exception 'Live portal orders require count-based Canix catalog items';
  end if;

  select last_successful_run_id into current_run_id
  from public.canix_sync_state
  where id = 1;
  if current_run_id is null then
    raise exception 'No successful Canix snapshot is available';
  end if;
  select enforcement_mode into enforcement_mode_value
  from public.portal_lot_integrity_state where id = 1;

  for line_group in
    select order_id, product_id, sum(quantity)::integer as requested_quantity
    from inserted_lines
    group by order_id, product_id
    order by product_id, order_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(line_group.product_id, 0));
    item_id_value := substring(line_group.product_id from '^canix:item:([0-9]+)$')::bigint;

    select coalesce(sum(greatest(coalesce(package.orderable_units, package.weight, 0), 0)), 0)
    into available_units
    from public.canix_package_current package
    where package.sync_run_id = current_run_id
      and package.item_id = item_id_value
      and package.quantity_type = 'CountBased'
      and package.status_category = 'available'
      and greatest(coalesce(package.orderable_units, package.weight, 0), 0) > 0
      and regexp_replace(lower(coalesce(package.test_result_status, package.lab_test_status, '')), '[^a-z0-9]+', '', 'g') <> 'testfailed'
      and (
        enforcement_mode_value <> 'block'
        or exists (
          select 1 from public.portal_package_lot_control control
          where control.package_id = package.package_id
            and control.allocation_eligible
        )
      );

    select coalesce(sum(greatest(commitment.quantity - coalesce(coverage.allocated_units, 0), 0)), 0)
    into already_committed
    from public.portal_inventory_commitment commitment
    join public.portal_order orders on orders.id = commitment.order_id
    left join lateral (
      select coalesce(sum(greatest(coalesce(package.weight, 0), 0)), 0) as allocated_units
      from public.canix_package_current package
      where package.sync_run_id = current_run_id
        and package.item_id = item_id_value
        and package.quantity_type = 'CountBased'
        and package.status_category = 'allocated'
        and package.sales_order_id = orders.canix_sales_order_id
        and regexp_replace(lower(coalesce(package.test_result_status, package.lab_test_status, '')), '[^a-z0-9]+', '', 'g') <> 'testfailed'
        and (
          enforcement_mode_value <> 'block'
          or exists (
            select 1 from public.portal_package_lot_control control
            where control.package_id = package.package_id
              and control.allocation_eligible
          )
        )
    ) coverage on orders.canix_sales_order_id is not null
    where commitment.product_id = line_group.product_id and commitment.active;

    if line_group.requested_quantity > available_units - already_committed then
      raise exception 'Requested quantity exceeds Canix availability after active portal commitments and lot controls';
    end if;

    insert into public.portal_inventory_commitment (order_id, product_id, quantity)
    values (line_group.order_id, line_group.product_id, line_group.requested_quantity)
    on conflict (order_id, product_id) do update
    set quantity = public.portal_inventory_commitment.quantity + excluded.quantity,
        active = true,
        released_at = null;
  end loop;

  return null;
end;
$$;

revoke all on function public.portal_reconcile_lot_integrity() from public, anon, authenticated;
revoke all on function public.portal_publish_monday_lots(text, jsonb) from public, anon, authenticated;
revoke all on function public.portal_set_lot_integrity_mode(text) from public, anon, authenticated;
revoke all on function public.portal_reconcile_lots_after_canix_publish() from public, anon, authenticated;
revoke all on function public.portal_commit_order_line_inventory() from public, anon, authenticated;

grant execute on function public.portal_reconcile_lot_integrity() to service_role;
grant execute on function public.portal_publish_monday_lots(text, jsonb) to service_role;
grant execute on function public.portal_set_lot_integrity_mode(text) to service_role;
grant execute on function public.portal_reconcile_lots_after_canix_publish() to service_role;
grant execute on function public.portal_commit_order_line_inventory() to service_role;

comment on table public.portal_inbound_lot is
  'Protected mirror of the Monday UX Inbound Lot Register. Approved lot IDs lock on first publication; later edits are detected, not silently accepted.';
comment on table public.portal_package_lot_control is
  'Current package-to-lot integrity decision. Non-valid rows become allocation blockers only when enforcement_mode is explicitly changed to block.';
comment on table public.portal_lot_integrity_state is
  'Singleton rollout state and non-sensitive integrity counters. Defaults to monitor until the historical Canix pointer backlog is reconciled.';
