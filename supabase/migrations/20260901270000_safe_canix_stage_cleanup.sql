-- Supabase enables a safe-update guard that rejects DELETE statements without
-- a WHERE clause, including inside SECURITY DEFINER functions. Keep the
-- atomic snapshot publication but make the intentional full stage cleanup
-- explicit so a completed sync can commit.

create or replace function public.canix_publish_sync_run(
  p_run_id uuid,
  p_package_count integer,
  p_package_pages integer,
  p_sales_order_pages integer,
  p_latest_source_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_state public.canix_sync_state%rowtype;
  staged_count integer;
  column_list text;
  update_list text;
  completed_at timestamptz := now();
begin
  if p_run_id is null then raise exception 'A synchronization run ID is required'; end if;
  if p_package_count < 0 or p_package_pages < 0 or p_sales_order_pages < 0 then
    raise exception 'Synchronization counters must be non-negative';
  end if;

  select * into current_state
  from public.canix_sync_state
  where id = 1
  for update;

  if current_state.status <> 'running' or current_state.active_run_id is distinct from p_run_id then
    raise exception 'Canix sync ownership was lost before snapshot publication';
  end if;

  select count(*) into staged_count
  from public.canix_package_sync_stage
  where sync_run_id = p_run_id;
  if staged_count <> p_package_count then
    raise exception 'The staged Canix package count does not match the completed fetch';
  end if;

  select
    string_agg(format('%I', column_name), ', ' order by ordinal_position),
    string_agg(format('%1$I = excluded.%1$I', column_name), ', ' order by ordinal_position)
      filter (where column_name <> 'package_id')
  into column_list, update_list
  from information_schema.columns
  where table_schema = 'public' and table_name = 'canix_package_current';

  execute format(
    'insert into public.canix_package_current (%1$s)
       select %1$s from public.canix_package_sync_stage where sync_run_id = $1
     on conflict (package_id) do update set %2$s',
    column_list,
    update_list
  ) using p_run_id;

  insert into public.canix_package_coa (
    package_id, canix_item_id, compliance_tag, document_url,
    source_document_id, lab_name, batch_number, tested_at, result_status,
    cannabinoids, terpenes, profile, source_updated_at, synced_at,
    source_payload
  )
  select
    package_id, item_id, tag, coa_url, coa_document_id, lab_name,
    lab_batch_number, lab_tested_at,
    coalesce(test_result_status, lab_test_status), cannabinoids, terpenes,
    lab_profile, source_updated_at, synced_at,
    jsonb_build_object(
      'coa_url', coa_url,
      'coa_document_id', coa_document_id,
      'lab_name', lab_name,
      'lab_batch_number', lab_batch_number,
      'lab_tested_at', lab_tested_at
    )
  from public.canix_package_current
  where sync_run_id = p_run_id
  on conflict (package_id) do update
  set canix_item_id = excluded.canix_item_id,
      compliance_tag = excluded.compliance_tag,
      document_url = excluded.document_url,
      source_document_id = excluded.source_document_id,
      lab_name = excluded.lab_name,
      batch_number = excluded.batch_number,
      tested_at = excluded.tested_at,
      result_status = excluded.result_status,
      cannabinoids = excluded.cannabinoids,
      terpenes = excluded.terpenes,
      profile = excluded.profile,
      source_updated_at = excluded.source_updated_at,
      synced_at = excluded.synced_at,
      source_payload = excluded.source_payload;

  delete from public.canix_package_current where sync_run_id <> p_run_id;

  update public.canix_sync_state
  set status = 'success',
      active_run_id = null,
      last_successful_run_id = p_run_id,
      last_completed_at = completed_at,
      last_successful_at = completed_at,
      latest_source_updated_at = p_latest_source_updated_at,
      package_count = p_package_count,
      package_pages = p_package_pages,
      sales_order_pages = p_sales_order_pages,
      last_error = null,
      updated_at = completed_at
  where id = 1;

  delete from public.canix_package_sync_stage where true;

  return jsonb_build_object(
    'published', true,
    'runId', p_run_id,
    'packages', p_package_count,
    'completedAt', completed_at
  );
end;
$$;

revoke all on function public.canix_publish_sync_run(uuid, integer, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.canix_publish_sync_run(uuid, integer, integer, integer, timestamptz)
  to service_role;

comment on function public.canix_publish_sync_run(uuid, integer, integer, integer, timestamptz) is
  'Atomically publishes a fully staged Canix snapshot, updates COAs, retires stale packages, and explicitly clears the private stage table.';

