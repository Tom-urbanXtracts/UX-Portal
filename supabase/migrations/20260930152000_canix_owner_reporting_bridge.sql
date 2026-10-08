-- Preserve Canix Reporting Package Owner assignments beside the REST-backed
-- package snapshot. The public REST Package schema does not expose Owner, so
-- the five-minute REST refresh must not erase the most recent Reporting
-- snapshot. Brand remains descriptive identity; Package Owner remains an
-- operational Canix user and is never treated as Economic Owner.

create table if not exists public.canix_package_owner_snapshot (
  package_id bigint primary key check (package_id > 0),
  owner_id bigint not null check (owner_id > 0),
  owner_name text not null check (length(btrim(owner_name)) between 1 and 200),
  source_updated_at timestamptz,
  snapshot_run_id uuid not null,
  synced_at timestamptz not null default now(),
  source_system text not null default 'canix_reporting'
    check (source_system = 'canix_reporting')
);

create index if not exists canix_package_owner_snapshot_owner_idx
  on public.canix_package_owner_snapshot (owner_id, package_id);

alter table public.canix_package_owner_snapshot enable row level security;
revoke all on table public.canix_package_owner_snapshot from public, anon, authenticated;
grant all on table public.canix_package_owner_snapshot to service_role;

comment on table public.canix_package_owner_snapshot is
  'Last complete Package Owner snapshot imported from Canix Reporting. This operational user assignment is separate from Brand and Economic Owner.';

create or replace function public.canix_apply_package_owner_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  mapped_owner public.canix_package_owner_snapshot%rowtype;
begin
  -- Prefer a future documented REST value when Canix begins returning one.
  -- Until then, fill the explicit operational-owner columns from Reporting.
  if new.canix_package_owner_id is null then
    select * into mapped_owner
    from public.canix_package_owner_snapshot
    where package_id = new.package_id;

    if found then
      new.canix_package_owner_id := mapped_owner.owner_id;
      new.canix_package_owner_name := mapped_owner.owner_name;
    end if;
  end if;

  -- Deprecated compatibility columns must never be repurposed.
  new.owner_id := null;
  new.owner_name := null;
  return new;
end;
$$;

drop trigger if exists canix_package_current_apply_owner_snapshot
  on public.canix_package_current;
create trigger canix_package_current_apply_owner_snapshot
before insert or update on public.canix_package_current
for each row execute function public.canix_apply_package_owner_snapshot();

revoke all on function public.canix_apply_package_owner_snapshot()
  from public, anon, authenticated;

create or replace function public.canix_replace_package_owner_snapshot(
  p_snapshot_run_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  imported_count integer;
  duplicate_count integer;
  invalid_count integer;
  completed_at timestamptz := now();
begin
  if p_snapshot_run_id is null then
    raise exception 'A Package Owner snapshot run ID is required';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Package Owner rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) > 10000 then
    raise exception 'Package Owner snapshot exceeds the 10,000-row safety limit';
  end if;

  create temporary table owner_import (
    package_id bigint,
    owner_id bigint,
    owner_name text,
    source_updated_at timestamptz
  ) on commit drop;

  insert into owner_import (package_id, owner_id, owner_name, source_updated_at)
  select package_id, owner_id, btrim(owner_name), source_updated_at
  from jsonb_to_recordset(p_rows) as row(
    package_id bigint,
    owner_id bigint,
    owner_name text,
    source_updated_at timestamptz
  );

  select count(*) into invalid_count
  from owner_import
  where package_id is null or package_id <= 0
     or owner_id is null or owner_id <= 0
     or owner_name is null or length(btrim(owner_name)) not between 1 and 200;
  if invalid_count > 0 then
    raise exception 'Package Owner snapshot contains % invalid row(s)', invalid_count;
  end if;

  select count(*) - count(distinct package_id) into duplicate_count
  from owner_import;
  if duplicate_count > 0 then
    raise exception 'Package Owner snapshot contains % duplicate package ID(s)', duplicate_count;
  end if;

  delete from public.canix_package_owner_snapshot where package_id > 0;
  insert into public.canix_package_owner_snapshot (
    package_id, owner_id, owner_name, source_updated_at,
    snapshot_run_id, synced_at, source_system
  )
  select package_id, owner_id, owner_name, source_updated_at,
         p_snapshot_run_id, completed_at, 'canix_reporting'
  from owner_import;

  get diagnostics imported_count = row_count;

  -- Apply the complete Reporting snapshot to the active REST cache now.
  -- A package absent from the complete Reporting snapshot is unassigned.
  update public.canix_package_current as package
  set canix_package_owner_id = owner.owner_id,
      canix_package_owner_name = owner.owner_name,
      owner_id = null,
      owner_name = null
  from public.canix_package_owner_snapshot as owner
  where owner.package_id = package.package_id;

  update public.canix_package_current as package
  set canix_package_owner_id = null,
      canix_package_owner_name = null,
      owner_id = null,
      owner_name = null
  where package.canix_package_owner_id is not null
    and not exists (
      select 1
      from public.canix_package_owner_snapshot as owner
      where owner.package_id = package.package_id
    );

  return jsonb_build_object(
    'published', true,
    'snapshotRunId', p_snapshot_run_id,
    'packages', imported_count,
    'completedAt', completed_at
  );
end;
$$;

revoke all on function public.canix_replace_package_owner_snapshot(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.canix_replace_package_owner_snapshot(uuid, jsonb)
  to service_role;

comment on function public.canix_replace_package_owner_snapshot(uuid, jsonb) is
  'Atomically replaces the complete Canix Reporting Package Owner snapshot and reconciles the current REST-backed package cache. Service role only.';
