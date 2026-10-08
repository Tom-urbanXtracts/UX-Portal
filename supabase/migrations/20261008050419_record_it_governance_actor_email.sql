-- Retain the authenticated actor email in administrative audit evidence.

create or replace function public.portal_record_offboarding_auth_state(
  p_actor_id uuid, p_actor_email text, p_offboarding_case_id uuid,
  p_auth_state text, p_auth_note text
)
returns public.portal_offboarding_case
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; case_row public.portal_offboarding_case;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then raise exception 'Administrator access is required'; end if;
  if p_auth_state not in ('revoked', 'failed') then raise exception 'Unsupported Auth revocation state'; end if;
  update public.portal_offboarding_case set
    auth_revocation_state = p_auth_state,
    auth_revocation_note = nullif(btrim(coalesce(p_auth_note, '')), '')
  where id = p_offboarding_case_id returning * into case_row;
  if not found then raise exception 'Offboarding case not found'; end if;
  insert into public.portal_admin_audit (actor_id, action, target_id, target_email, detail) values (
    p_actor_id,
    case when p_auth_state = 'revoked' then 'offboarding_auth_revoked' else 'offboarding_auth_revocation_failed' end,
    case_row.target_profile_id, case_row.target_email,
    jsonb_build_object('offboardingCaseId', case_row.id, 'reference', case_row.reference,
      'authRevocationState', p_auth_state, 'actorEmail', p_actor_email));
  return case_row;
end;
$$;

create or replace function public.portal_update_it_system(
  p_actor_id uuid, p_actor_email text, p_system_key text, p_expected_version integer,
  p_connection_state text, p_health_state text, p_freshness text,
  p_next_review_on date, p_evidence_note text
)
returns public.portal_it_system
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; system_row public.portal_it_system;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id for share;
  if not found or actor_row.active is not true or actor_row.role <> 'internal'
    or actor_row.staff_role <> 'administrator' then raise exception 'Administrator access is required'; end if;
  if p_connection_state not in ('connected', 'manual', 'not_connected', 'on_hold', 'unknown')
    or p_health_state not in ('healthy', 'degraded', 'outage', 'unknown', 'not_applicable')
    or p_freshness not in ('real_time', 'event_driven', 'five_minutes', 'scheduled', 'manual', 'unknown', 'not_applicable')
    then raise exception 'Unsupported system state'; end if;
  if length(btrim(coalesce(p_evidence_note, ''))) < 8 then raise exception 'Verification evidence is required'; end if;
  select * into system_row from public.portal_it_system where system_key = p_system_key for update;
  if not found then raise exception 'System not found'; end if;
  if system_row.version <> p_expected_version then raise exception 'System register changed'; end if;
  update public.portal_it_system set
    connection_state = p_connection_state, health_state = p_health_state,
    freshness = p_freshness, next_review_on = p_next_review_on,
    evidence_note = btrim(p_evidence_note), last_verified_at = now()
  where system_key = p_system_key returning * into system_row;
  insert into public.portal_admin_audit (actor_id, action, detail) values (
    p_actor_id, 'privileged_system_verified',
    jsonb_build_object('systemKey', system_row.system_key,
      'connectionState', system_row.connection_state, 'healthState', system_row.health_state,
      'freshness', system_row.freshness, 'nextReviewOn', system_row.next_review_on,
      'evidenceNote', system_row.evidence_note, 'actorEmail', p_actor_email));
  return system_row;
end;
$$;
