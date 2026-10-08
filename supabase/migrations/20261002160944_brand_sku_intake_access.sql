-- Allow active Brand members to create and contribute to SKU intake records
-- for their own organization. The Edge Function remains the only browser
-- access path; organization_id is the durable authorization boundary.

alter table public.portal_sku_intake
  add column if not exists organization_id uuid
    references public.portal_organization(id) on delete restrict;

-- Backfill only unambiguous exact Brand-name matches. Records without a safe
-- match remain Internal-only until an administrator links them deliberately.
with unique_brand_names as (
  select lower(btrim(display_name)) as normalized_name,
    (array_agg(id order by id))[1] as organization_id
  from public.portal_organization
  where kind = 'brand'
  group by lower(btrim(display_name))
  having count(*) = 1
)
update public.portal_sku_intake as intake
set organization_id = match.organization_id
from unique_brand_names as match
where intake.organization_id is null
  and lower(btrim(intake.brand_name)) = match.normalized_name;

create index if not exists portal_sku_intake_organization_idx
  on public.portal_sku_intake (organization_id, updated_at desc);

alter table public.portal_sku_intake_section_revision
  drop constraint if exists portal_sku_intake_section_revision_actor_type_check;
alter table public.portal_sku_intake_section_revision
  add constraint portal_sku_intake_section_revision_actor_type_check
  check (actor_type in ('internal', 'brand', 'contributor'));

alter table public.portal_sku_intake_event
  drop constraint if exists portal_sku_intake_event_actor_type_check;
alter table public.portal_sku_intake_event
  add constraint portal_sku_intake_event_actor_type_check
  check (actor_type in ('internal', 'brand', 'contributor', 'system'));

alter table public.portal_sku_intake_document
  drop constraint if exists portal_sku_intake_document_uploaded_by_type_check;
alter table public.portal_sku_intake_document
  add constraint portal_sku_intake_document_uploaded_by_type_check
  check (uploaded_by_type in ('internal', 'brand', 'contributor'));

-- Preserve the original service-only posture. Active Brand membership and
-- workspace permissions are enforced in portal-sku-intake before service-role
-- reads or writes occur.
revoke all on table public.portal_sku_intake, public.portal_sku_intake_section,
  public.portal_sku_intake_section_invite, public.portal_sku_intake_section_revision,
  public.portal_sku_intake_event, public.portal_sku_intake_document
  from public, anon, authenticated;
grant all on table public.portal_sku_intake, public.portal_sku_intake_section,
  public.portal_sku_intake_section_invite, public.portal_sku_intake_section_revision,
  public.portal_sku_intake_event, public.portal_sku_intake_document to service_role;

comment on column public.portal_sku_intake.organization_id is
  'Stable Brand organization boundary. Null legacy rows remain visible only to authorized Internal users.';
