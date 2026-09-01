-- Make the retailer-ordering projection explicit and auditable. Canix item_id
-- is the v1 catalog identity because it is present on the package population;
-- product_id is retained as useful metadata but is not complete enough to be
-- the catalog key. Reservation and case values remain nullable when the Canix
-- REST response does not supply them.

alter table public.canix_package_current
  add column if not exists product_id bigint,
  add column if not exists case_quantity integer,
  add column if not exists case_quantity_unit text,
  add column if not exists reservation_state text not null default 'unknown',
  add column if not exists reservation_source_field text,
  add column if not exists orderable_units numeric;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.canix_package_current'::regclass
      and conname = 'canix_package_current_case_quantity_check'
  ) then
    alter table public.canix_package_current
      add constraint canix_package_current_case_quantity_check
      check (case_quantity is null or case_quantity > 0) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.canix_package_current'::regclass
      and conname = 'canix_package_current_reservation_state_check'
  ) then
    alter table public.canix_package_current
      add constraint canix_package_current_reservation_state_check
      check (reservation_state in ('known', 'unknown')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.canix_package_current'::regclass
      and conname = 'canix_package_current_orderable_units_check'
  ) then
    alter table public.canix_package_current
      add constraint canix_package_current_orderable_units_check
      check (orderable_units is null or orderable_units >= 0) not valid;
  end if;
end
$$;

alter table public.canix_package_current
  validate constraint canix_package_current_case_quantity_check;
alter table public.canix_package_current
  validate constraint canix_package_current_reservation_state_check;
alter table public.canix_package_current
  validate constraint canix_package_current_orderable_units_check;

-- Existing snapshots did not record reservation coverage. Preserve their
-- current available-count behavior while marking the basis as unknown; the
-- next Canix sync replaces these values with source-aware normalization.
update public.canix_package_current
set orderable_units = case
      when quantity_type = 'CountBased' and status_category = 'available'
        then greatest(coalesce(weight, 0), 0)
      else 0
    end,
    reservation_state = 'unknown'
where orderable_units is null;

create index if not exists canix_package_current_product_idx
  on public.canix_package_current (product_id);
create index if not exists canix_package_current_orderable_item_idx
  on public.canix_package_current (item_id, orderable_units)
  where quantity_type = 'CountBased' and status_category = 'available';

alter table public.portal_store
  add column if not exists enforce_case_quantity boolean not null default false;

comment on column public.canix_package_current.product_id is
  'Optional Canix product identifier. Retained as metadata; item_id remains the v1 catalog grouping key because product_id coverage is incomplete.';
comment on column public.canix_package_current.c_reserved_weight is
  'Canix reservation amount in the package native unit when the REST response supplies an approved reservation field; otherwise null.';
comment on column public.canix_package_current.reservation_state is
  'Known only when the Canix REST response explicitly supplied a reservation value. Unknown values are never represented as zero.';
comment on column public.canix_package_current.orderable_units is
  'Count-based package quantity available to order. Explicit reservations are subtracted; status-only fallback is identified by reservation_state=unknown.';
comment on column public.portal_store.enforce_case_quantity is
  'When true, portal intake requires each Canix item quantity to be a whole multiple of its positive, unambiguous Canix case_quantity. Defaults off.';
