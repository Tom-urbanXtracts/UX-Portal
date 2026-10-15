-- Recover an Item Master run abandoned by an interrupted Edge Function.
-- A healthy run retains its lock for 30 minutes; older runs are safely
-- superseded and their private staging rows are discarded before a new claim.
create or replace function public.canix_claim_item_sync_run(
  p_run_id uuid,
  p_force boolean default false,
  p_fresh_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_state public.canix_item_sync_state%rowtype;
  started_at timestamptz := now();
  abandoned_run_id uuid;
begin
  if p_run_id is null then raise exception 'An item synchronization run ID is required'; end if;
  if p_fresh_seconds < 0 or p_fresh_seconds > 3600 then raise exception 'Invalid freshness window'; end if;

  select * into current_state
  from public.canix_item_sync_state
  where id = 1
  for update;

  if current_state.status = 'running'
    and current_state.last_started_at is not null
    and current_state.last_started_at > started_at - interval '30 minutes' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'already_running',
      'lastStartedAt', current_state.last_started_at,
      'activeRunId', current_state.active_run_id
    );
  end if;

  if current_state.status = 'running' then
    abandoned_run_id := current_state.active_run_id;
    if abandoned_run_id is not null then
      delete from public.canix_item_sync_stage where sync_run_id = abandoned_run_id;
    end if;
  end if;

  if not p_force and current_state.status <> 'running'
    and current_state.last_successful_at is not null
    and current_state.last_successful_at > started_at - make_interval(secs => p_fresh_seconds) then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'fresh',
      'lastSuccessfulAt', current_state.last_successful_at
    );
  end if;

  update public.canix_item_sync_state
  set status = 'running',
      active_run_id = p_run_id,
      last_started_at = started_at,
      last_error = null,
      updated_at = started_at
  where id = 1;

  return jsonb_build_object(
    'claimed', true,
    'runId', p_run_id,
    'startedAt', started_at,
    'recoveredRunId', abandoned_run_id
  );
end;
$$;

revoke all on function public.canix_claim_item_sync_run(uuid, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.canix_claim_item_sync_run(uuid, boolean, integer)
  to service_role;
