-- Complete the approved P1 source-of-record decisions. monday.com records are
-- retained as history, but new Brand manufacturing and catalog-content work is
-- created, reviewed, and completed in the Portal.

update public.portal_workflow_control
set mode = 'portal',
    monday_retention = 'retain_read_only',
    change_note = 'The Portal owns Brand manufacturing milestones, exceptions, dates, assignments, evidence, and audit history. Existing Monday records remain read-only history.',
    changed_at = now()
where workflow_key = 'brand_manufacturing';

update public.portal_workflow_control
set mode = 'portal',
    monday_retention = 'retain_read_only',
    change_note = 'The Portal owns catalog content, completeness, review, approval, scheduling, publication, and audit history. Existing Monday identifiers remain read-only history.',
    changed_at = now()
where workflow_key = 'catalog_content';

insert into public.portal_workflow_control (
  workflow_key, display_name, mode, monday_retention, change_note
) values (
  'brand_finance', 'Brand finance rules', 'hold', 'retain_read_only',
  'On hold pending Finance approval of Brand classification, sales-dollar visibility, statements, settlement rules, and banking boundaries.'
) on conflict (workflow_key) do update set
  display_name = excluded.display_name,
  mode = excluded.mode,
  monday_retention = excluded.monday_retention,
  change_note = excluded.change_note,
  changed_at = now();

-- Existing Monday projections remain visible as historical evidence. New
-- milestones use a stable Portal UUID and no longer require a Monday item.
alter table public.portal_brand_manufacturing_projection
  alter column monday_item_id drop not null,
  drop constraint if exists portal_brand_manufacturing_projection_status_check;

alter table public.portal_brand_manufacturing_projection
  add constraint portal_brand_manufacturing_projection_status_check check (
    status in (
      'planned', 'submitted', 'approved', 'scheduled', 'in_production',
      'quality_hold', 'quality_review', 'complete', 'shipped', 'closed',
      'on_hold', 'cancelled', 'exception'
    )
  ),
  add column if not exists source_mode text not null default 'portal'
    check (source_mode in ('portal', 'monday_historical')),
  add column if not exists priority text not null default 'P1'
    check (priority in ('P0', 'P1', 'P2', 'P3')),
  add column if not exists assigned_department text not null default 'Administrator',
  add column if not exists assigned_user uuid references auth.users(id) on delete set null,
  add column if not exists due_at timestamptz,
  add column if not exists revision integer not null default 1 check (revision > 0),
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_by uuid references auth.users(id) on delete set null;

update public.portal_brand_manufacturing_projection
set source_mode = case when monday_item_id is not null then 'monday_historical' else 'portal' end,
    assigned_department = 'Administrator'
where source_mode is distinct from
  case when monday_item_id is not null then 'monday_historical' else 'portal' end
   or assigned_department is distinct from 'Administrator';

create index if not exists portal_brand_mfg_reference_idx
  on public.portal_brand_manufacturing_projection (organization_id, reference);

create or replace function public.portal_brand_manufacturing_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if new.revision = old.revision then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists portal_brand_manufacturing_touch
  on public.portal_brand_manufacturing_projection;
create trigger portal_brand_manufacturing_touch
before update on public.portal_brand_manufacturing_projection
for each row execute function public.portal_brand_manufacturing_touch();

create or replace function public.portal_sync_brand_manufacturing_work_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  queue_status text;
begin
  if new.source_mode <> 'portal' then return new; end if;
  queue_status := case
    when new.status in ('complete', 'shipped', 'closed') then 'completed'
    when new.status = 'cancelled' then 'cancelled'
    when new.status in ('on_hold', 'quality_hold', 'exception') then 'waiting'
    when new.status in ('planned', 'submitted') then 'not_started'
    else 'in_progress'
  end;
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, organization_id, title, summary,
    status, priority, assigned_department, assigned_user, due_at, source_mode,
    source_record_id, metadata, created_by, updated_by, completed_at
  ) values (
    'brand_manufacturing', 'brand_manufacturing', new.id::text,
    new.organization_id, new.reference,
    coalesce(new.product_name, 'Brand manufacturing milestone'), queue_status,
    new.priority, 'Administrator', new.assigned_user,
    coalesce(new.due_at,
      case when new.planned_on is not null then new.planned_on::timestamptz else null end),
    'portal', null,
    jsonb_build_object('manufacturingStatus', new.status, 'revision', new.revision),
    new.created_by, new.updated_by,
    case when queue_status = 'completed' then coalesce(new.completed_on::timestamptz, now()) else null end
  )
  on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title,
    summary = excluded.summary,
    status = excluded.status,
    priority = excluded.priority,
    assigned_department = 'Administrator',
    assigned_user = excluded.assigned_user,
    due_at = excluded.due_at,
    source_mode = 'portal',
    metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_brand_manufacturing_work_item
  on public.portal_brand_manufacturing_projection;
create trigger portal_sync_brand_manufacturing_work_item
after insert or update on public.portal_brand_manufacturing_projection
for each row execute function public.portal_sync_brand_manufacturing_work_item();

-- Catalog content is now authored directly against the stable Canix Item ID.
-- Monday identifiers remain nullable historical references and are never
-- required for a Portal edit.
alter table public.portal_product_content
  add column if not exists source_mode text not null default 'portal'
    check (source_mode in ('portal', 'monday_historical')),
  add column if not exists revision integer not null default 1 check (revision > 0);

update public.portal_product_content
set source_mode = 'portal'
where source_mode is distinct from 'portal';

create or replace function public.portal_product_content_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if new.revision = old.revision then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists portal_product_content_touch on public.portal_product_content;
create trigger portal_product_content_touch
before update on public.portal_product_content
for each row execute function public.portal_product_content_touch();

create or replace function public.portal_sync_catalog_content_work_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  queue_status text;
begin
  queue_status := case
    when new.workflow_state = 'published' then 'completed'
    when new.workflow_state = 'archived' then 'cancelled'
    when new.workflow_state = 'draft' then 'not_started'
    else 'in_progress'
  end;
  insert into public.portal_work_item (
    workflow_key, target_type, target_id, title, summary, status, priority,
    assigned_department, source_mode, source_record_id, metadata,
    created_by, updated_by, completed_at
  ) values (
    'catalog_content', 'catalog_content', new.canix_item_id::text,
    'Canix item ' || new.canix_item_id::text || ' catalog content',
    coalesce(new.short_description, 'Portal catalog content'), queue_status,
    'P1', 'Administrator', 'portal', new.monday_item_id,
    jsonb_build_object(
      'workflowState', new.workflow_state,
      'completenessScore', new.completeness_score,
      'revision', new.revision
    ),
    new.updated_by, new.updated_by,
    case when queue_status = 'completed' then now() else null end
  )
  on conflict (workflow_key, target_type, target_id) do update set
    title = excluded.title,
    summary = excluded.summary,
    status = excluded.status,
    priority = 'P1',
    assigned_department = 'Administrator',
    source_mode = 'portal',
    source_record_id = coalesce(public.portal_work_item.source_record_id, excluded.source_record_id),
    metadata = public.portal_work_item.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists portal_sync_catalog_content_work_item
  on public.portal_product_content;
create trigger portal_sync_catalog_content_work_item
after insert or update on public.portal_product_content
for each row execute function public.portal_sync_catalog_content_work_item();

-- Backfill the Portal queue without altering any published content.
update public.portal_product_content set source_mode = 'portal';

comment on column public.portal_brand_manufacturing_projection.source_mode is
  'Portal is authoritative for new milestones. monday_historical rows remain visible but are never workflow inputs.';
comment on column public.portal_product_content.source_mode is
  'Portal is authoritative for catalog content. Monday IDs, when present, are retained only as historical references.';
