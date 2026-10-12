-- Cover the auth.users foreign key used by approval-history lookups and user removal.
create index if not exists portal_item_source_mapping_approved_by_idx
  on public.portal_item_source_mapping (approved_by)
  where approved_by is not null;
