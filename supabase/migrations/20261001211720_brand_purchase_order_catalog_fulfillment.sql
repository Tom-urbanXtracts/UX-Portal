-- Brand purchase-order catalog, price snapshots, and fulfillment evidence.
-- Existing orders remain readable; the new fields are nullable where legacy
-- records cannot supply a reliable value.

alter table public.portal_brand_purchase_order
  add column if not exists shipping_destination text,
  add column if not exists customer_reference text,
  add column if not exists subtotal_cents bigint check (subtotal_cents is null or subtotal_cents >= 0);

alter table public.portal_brand_purchase_order
  alter column currency set default 'USD';

update public.portal_brand_purchase_order
set currency = 'USD'
where currency is null;

alter table public.portal_brand_purchase_order_line
  add column if not exists order_basis text check (order_basis is null or order_basis in ('unit', 'case')),
  add column if not exists ordered_units numeric check (ordered_units is null or ordered_units > 0),
  add column if not exists case_quantity numeric check (case_quantity is null or case_quantity > 0),
  add column if not exists unit_price_cents bigint check (unit_price_cents is null or unit_price_cents >= 0),
  add column if not exists case_price_cents bigint check (case_price_cents is null or case_price_cents >= 0),
  add column if not exists line_total_cents bigint check (line_total_cents is null or line_total_cents >= 0);

update public.portal_brand_purchase_order_line
set order_basis = 'unit',
    ordered_units = requested_quantity
where order_basis is null;

create table if not exists public.portal_brand_purchase_order_fulfillment_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.portal_organization(id) on delete cascade,
  purchase_order_id uuid not null references public.portal_brand_purchase_order(id) on delete cascade,
  purchase_order_line_id bigint not null references public.portal_brand_purchase_order_line(id) on delete cascade,
  event_type text not null check (event_type in ('shipped', 'received', 'damaged', 'rejected', 'refused')),
  quantity numeric not null check (quantity > 0),
  shipment_reference text not null check (length(trim(shipment_reference)) > 0),
  carrier text,
  tracking_number text,
  manifest_reference text,
  proof_of_delivery_reference text,
  receiver_name text,
  note text,
  occurred_on date not null default current_date,
  brand_visible boolean not null default true,
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_by_email text,
  created_at timestamptz not null default now()
);

create index if not exists portal_brand_po_fulfillment_order_idx
  on public.portal_brand_purchase_order_fulfillment_event
  (purchase_order_id, occurred_on desc, created_at desc);

create index if not exists portal_brand_po_fulfillment_line_idx
  on public.portal_brand_purchase_order_fulfillment_event
  (purchase_order_line_id, event_type);

create or replace function public.portal_validate_brand_po_fulfillment_event()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  line_record public.portal_brand_purchase_order_line%rowtype;
  order_record public.portal_brand_purchase_order%rowtype;
  ordered_quantity numeric;
  shipped_quantity numeric;
  disposition_quantity numeric;
begin
  select * into line_record
  from public.portal_brand_purchase_order_line
  where id = new.purchase_order_line_id
  for update;
  if not found then raise exception 'Purchase-order line not found'; end if;

  select * into order_record
  from public.portal_brand_purchase_order
  where id = line_record.purchase_order_id;
  if order_record.organization_id <> new.organization_id
     or order_record.id <> new.purchase_order_id then
    raise exception 'Fulfillment event is outside the purchase-order scope';
  end if;

  ordered_quantity := coalesce(line_record.ordered_units, line_record.requested_quantity);
  select
    coalesce(sum(quantity) filter (where event_type = 'shipped'), 0),
    coalesce(sum(quantity) filter (where event_type in ('received', 'damaged', 'rejected', 'refused')), 0)
  into shipped_quantity, disposition_quantity
  from public.portal_brand_purchase_order_fulfillment_event
  where purchase_order_line_id = new.purchase_order_line_id;

  if new.event_type = 'shipped' and shipped_quantity + new.quantity > ordered_quantity then
    raise exception 'Shipped quantity cannot exceed the ordered quantity';
  end if;
  if new.event_type in ('received', 'damaged', 'rejected', 'refused')
     and disposition_quantity + new.quantity > shipped_quantity then
    raise exception 'Received and exception quantities cannot exceed the shipped quantity';
  end if;
  return new;
end;
$$;

drop trigger if exists portal_validate_brand_po_fulfillment_event
  on public.portal_brand_purchase_order_fulfillment_event;
create trigger portal_validate_brand_po_fulfillment_event
before insert on public.portal_brand_purchase_order_fulfillment_event
for each row execute function public.portal_validate_brand_po_fulfillment_event();

alter table public.portal_brand_purchase_order_fulfillment_event enable row level security;
revoke all on table public.portal_brand_purchase_order_fulfillment_event from public, anon, authenticated;
grant select, insert, update, delete on table public.portal_brand_purchase_order_fulfillment_event to service_role;

comment on table public.portal_brand_purchase_order_fulfillment_event is
  'Portal-owned immutable fulfillment, receipt, and delivery-exception evidence for Brand purchase-order lines.';
