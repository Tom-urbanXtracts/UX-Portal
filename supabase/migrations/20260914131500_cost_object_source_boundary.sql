-- A Canix sales-order line identifies an allocation, not the Finance-approved
-- Cost Object for an inbound lot. Remove the former alias from both the live
-- cache and private staging table. The runtime response may populate Cost
-- Object only by joining a valid package Lot ID to one active, approved row in
-- the protected Monday inbound-lot register.

update public.canix_package_current
set cost_object_id = null
where cost_object_id is not null;

update public.canix_package_sync_stage
set cost_object_id = null
where cost_object_id is not null;

drop index if exists public.canix_package_current_cost_object_idx;

alter table public.canix_package_current
  drop constraint if exists canix_package_current_cost_object_placeholder_check;

alter table public.canix_package_current
  add constraint canix_package_current_cost_object_placeholder_check
  check (cost_object_id is null);

alter table public.canix_package_sync_stage
  drop constraint if exists canix_package_sync_stage_cost_object_placeholder_check;

alter table public.canix_package_sync_stage
  add constraint canix_package_sync_stage_cost_object_placeholder_check
  check (cost_object_id is null);

comment on column public.canix_package_current.cost_object_id is
  'Deprecated stored placeholder. Must remain null; never copy a Canix sales-order line. Runtime Cost Object values resolve only from an approved Monday inbound-lot record through a valid Lot ID.';

comment on column public.canix_package_sync_stage.cost_object_id is
  'Deprecated stored placeholder. Must remain null; never copy a Canix sales-order line.';
