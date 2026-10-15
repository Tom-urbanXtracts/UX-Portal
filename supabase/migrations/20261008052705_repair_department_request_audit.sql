-- Repair the shared department request RPCs to use the established
-- portal_admin_audit contract: action/target_id/detail.
create or replace function public.portal_submit_department_request(
  p_actor_id uuid, p_actor_email text, p_department_key text, p_request_type text,
  p_title text, p_details text, p_priority text
) returns public.portal_department_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; department_row public.portal_department;
  request_row public.portal_department_request;
begin
  select * into actor_row from public.portal_profile where id = p_actor_id and active and role = 'internal';
  if actor_row.id is null then raise exception 'Active workforce account required'; end if;
  select * into department_row from public.portal_department where department_key = p_department_key;
  if department_row.department_key is null or department_row.status <> 'active' then
    raise exception 'Choose an active department';
  end if;
  if p_request_type !~ '^[a-z0-9_]{2,50}$' or length(btrim(coalesce(p_title,''))) < 5
    or length(btrim(coalesce(p_details,''))) < 12 or p_priority not in ('P0','P1','P2','P3') then
    raise exception 'Complete the department request';
  end if;
  insert into public.portal_department_request (
    requester_id, department_key, request_type, title, details, priority, assigned_department
  ) values (
    p_actor_id, p_department_key, p_request_type, btrim(p_title), btrim(p_details), p_priority,
    department_row.display_name
  ) returning * into request_row;
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'department_request_submitted', request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'departmentKey', p_department_key,
    'requestType', p_request_type,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

create or replace function public.portal_decide_department_request(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_department_request
language plpgsql set search_path = public, pg_temp as $$
declare actor_row public.portal_profile; request_row public.portal_department_request;
begin
  select * into actor_row from public.portal_profile
    where id = p_actor_id and active and role = 'internal' and staff_role = 'administrator';
  if actor_row.id is null then raise exception 'Administrator access required'; end if;
  select * into request_row from public.portal_department_request where id = p_request_id for update;
  if request_row.id is null then raise exception 'Department request not found'; end if;
  if request_row.version <> p_expected_version then raise exception 'Department request changed'; end if;
  if request_row.status not in ('submitted','under_review','returned','approved') then
    raise exception 'Department request is not reviewable';
  end if;
  if p_decision not in ('under_review','returned','approved','denied','completed') then
    raise exception 'Invalid department request decision';
  end if;
  if p_decision in ('returned','approved','denied','completed') and length(btrim(coalesce(p_note,''))) < 8 then
    raise exception 'Decision evidence required';
  end if;
  if p_decision = 'approved' and request_row.requester_id = p_actor_id then
    raise exception 'You cannot approve your own department request';
  end if;
  update public.portal_department_request set status = p_decision,
    reviewer_id = p_actor_id, reviewer_email = nullif(lower(btrim(coalesce(p_actor_email,''))), ''),
    decision_note = nullif(btrim(coalesce(p_note,'')), '')
  where id = p_request_id returning * into request_row;
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'department_request_' || p_decision, request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'departmentKey', request_row.department_key,
    'evidence', request_row.decision_note,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  return request_row;
end;
$$;

revoke all on function public.portal_submit_department_request(uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.portal_submit_department_request(uuid,text,text,text,text,text,text) to service_role;
revoke all on function public.portal_decide_department_request(uuid,text,uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.portal_decide_department_request(uuid,text,uuid,integer,text,text) to service_role;
