create index if not exists portal_owner_mapping_party_idx
  on public.portal_canix_owner_mapping (economic_party_id)
  where economic_party_id is not null;
create index if not exists portal_owner_mapping_approver_idx
  on public.portal_canix_owner_mapping (approved_by)
  where approved_by is not null;
create index if not exists portal_package_lot_approver_idx
  on public.portal_package_lot_overlay (approved_by)
  where approved_by is not null;
create index if not exists portal_item_mapping_sku_idx
  on public.portal_item_identity_mapping (portal_sku_id)
  where portal_sku_id is not null;
create index if not exists portal_item_mapping_approver_idx
  on public.portal_item_identity_mapping (approved_by)
  where approved_by is not null;
create index if not exists portal_lot_register_party_idx
  on public.portal_lot_register (economic_party_id)
  where economic_party_id is not null;
create index if not exists portal_lot_register_approver_idx
  on public.portal_lot_register (approved_by)
  where approved_by is not null;
create index if not exists portal_data_control_event_actor_idx
  on public.portal_data_control_event (actor_id)
  where actor_id is not null;
