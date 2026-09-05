-- A terminated Edge invocation must not leave package inventory permanently
-- locked in `running`. A replacement may claim an abandoned run after the
-- bounded stale window; the old run cannot publish because ownership changes.

create or replace function public.canix_claim_sync_run(
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
  current_state public.canix_sync_state%rowtype;
  started_at timestamptz := now();
  stale_after_seconds integer;
begin
  if p_run_id is null then raise exception 'A synchronization run ID is required'; end if;
  if p_fresh_seconds < 0 or p_fresh_seconds > 3600 then raise exception 'Invalid freshness window'; end if;
  stale_after_seconds := greatest(900, p_fresh_seconds * 3);

  select * into current_state
  from public.canix_sync_state
  where id = 1
  for update;

  if current_state.status = 'running'
    and current_state.last_started_at is not null
    and current_state.last_started_at > started_at - make_interval(secs => stale_after_seconds) then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'already_running',
      'lastStartedAt', current_state.last_started_at,
      'activeRunId', current_state.active_run_id
    );
  end if;

  if current_state.status = 'running' then
    delete from public.canix_package_sync_stage
    where sync_run_id = current_state.active_run_id;
  end if;

  if not p_force and current_state.last_successful_at is not null
    and current_state.last_successful_at > started_at - make_interval(secs => p_fresh_seconds) then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'fresh',
      'lastSuccessfulAt', current_state.last_successful_at
    );
  end if;

  update public.canix_sync_state
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
    'recoveredStaleRun', current_state.status = 'running'
  );
end;
$$;

revoke all on function public.canix_claim_sync_run(uuid, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.canix_claim_sync_run(uuid, boolean, integer)
  to service_role;

