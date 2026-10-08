-- Submit the access request, its first immutable decision, and its audit event
-- as one transaction. The Edge Function remains responsible for authenticating
-- the actor and validating requester scope before invoking this service-only RPC.

create or replace function public.portal_submit_access_request(
  p_requester_id uuid,
  p_requester_email text,
  p_target_profile_id uuid,
  p_requested_staff_role text,
  p_requested_department_key text,
  p_requested_department_role text,
  p_requested_expires_on date,
  p_justification text,
  p_risk_tier text
)
returns public.portal_access_request
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_row public.portal_access_request;
begin
  if not exists (
    select 1 from public.portal_profile
    where id = p_requester_id and role = 'internal' and active is true
  ) then
    raise exception 'Active requester profile not found';
  end if;

  if not exists (
    select 1 from public.portal_profile
    where id = p_target_profile_id and role = 'internal' and active is true
  ) then
    raise exception 'Active workforce profile not found';
  end if;

  insert into public.portal_access_request (
    requester_id, target_profile_id, requested_staff_role,
    requested_department_key, requested_department_role,
    requested_expires_on, justification, risk_tier, status, submitted_at
  ) values (
    p_requester_id, p_target_profile_id, p_requested_staff_role,
    nullif(btrim(coalesce(p_requested_department_key, '')), ''),
    p_requested_department_role, p_requested_expires_on,
    btrim(p_justification), p_risk_tier, 'submitted', now()
  ) returning * into request_row;

  insert into public.portal_access_request_decision (
    access_request_id, decision, actor_id, actor_email, note, evidence
  ) values (
    request_row.id, 'submitted', p_requester_id, p_requester_email,
    btrim(p_justification),
    jsonb_build_object(
      'requestedStaffRole', p_requested_staff_role,
      'departmentKey', p_requested_department_key,
      'departmentRole', p_requested_department_role,
      'requestedExpiresOn', p_requested_expires_on,
      'riskTier', p_risk_tier
    )
  );

  insert into public.portal_admin_audit (
    actor_id, action, target_id, detail
  ) values (
    p_requester_id, 'access_request_submitted', p_target_profile_id,
    jsonb_build_object(
      'accessRequestId', request_row.id,
      'reference', request_row.reference,
      'requestedStaffRole', p_requested_staff_role,
      'departmentKey', p_requested_department_key,
      'riskTier', p_risk_tier
    )
  );

  return request_row;
end;
$$;

revoke all on function public.portal_submit_access_request(
  uuid, text, uuid, text, text, text, date, text, text
) from public, anon, authenticated;
grant execute on function public.portal_submit_access_request(
  uuid, text, uuid, text, text, text, date, text, text
) to service_role;

comment on function public.portal_submit_access_request(
  uuid, text, uuid, text, text, text, date, text, text
) is 'Atomically creates a workforce access request, submission history, and administrative audit record.';
