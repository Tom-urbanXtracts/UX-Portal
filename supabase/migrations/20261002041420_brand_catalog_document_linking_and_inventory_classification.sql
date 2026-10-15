-- Hybrid product-document model:
-- 1. Canix Marketplace products may receive controlled attachments before a
--    formal SKU intake exists.
-- 2. Internal administrators later link the same stored file to a SKU packet
--    and approve it without copying or re-uploading the object.

alter table public.portal_brand_supply_document
  drop constraint if exists portal_brand_supply_document_entity_type_check;

alter table public.portal_brand_supply_document
  alter column entity_id drop not null,
  add column if not exists source_product_id text,
  add column if not exists source_product_name text,
  add column if not exists linked_sku_intake_id uuid
    references public.portal_sku_intake(id) on delete set null,
  add column if not exists document_state text not null default 'record_document',
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_by_email text,
  add column if not exists approved_at timestamptz;

alter table public.portal_brand_supply_document
  add constraint portal_brand_supply_document_entity_type_check
    check (entity_type in ('sku', 'vendor', 'component', 'marketplace_product')),
  add constraint portal_brand_supply_document_state_check
    check (document_state in (
      'record_document', 'pending_sku_link', 'approved_sku_document'
    )),
  add constraint portal_brand_supply_document_entity_pointer_check
    check (
      (entity_type = 'marketplace_product'
        and entity_id is null
        and nullif(btrim(coalesce(source_product_id, '')), '') is not null)
      or
      (entity_type <> 'marketplace_product'
        and entity_id is not null
        and source_product_id is null)
    ),
  add constraint portal_brand_supply_document_approval_state_check
    check (
      (document_state <> 'approved_sku_document')
      or (linked_sku_intake_id is not null and approved_at is not null)
    );

create unique index if not exists portal_brand_supply_document_marketplace_unique_idx
  on public.portal_brand_supply_document (
    organization_id, source_product_id, document_type, sha256
  ) where entity_type = 'marketplace_product';

create index if not exists portal_brand_supply_document_link_queue_idx
  on public.portal_brand_supply_document (
    organization_id, document_state, source_product_id, created_at desc
  ) where entity_type = 'marketplace_product' and status = 'current';

alter table public.portal_brand_component
  add column if not exists inventory_class text not null default 'unclassified';

alter table public.portal_brand_component
  add constraint portal_brand_component_inventory_class_check
    check (inventory_class in (
      'cannabis', 'non_cannabis', 'not_inventory', 'unclassified'
    ));

comment on column public.portal_brand_supply_document.document_state is
  'Catalog attachments remain pending until Internal links them to a formal SKU; the storage object is never duplicated.';
comment on column public.portal_brand_component.inventory_class is
  'Explicit Brand component inventory grouping. No quantity is inferred from a BOM record.';
