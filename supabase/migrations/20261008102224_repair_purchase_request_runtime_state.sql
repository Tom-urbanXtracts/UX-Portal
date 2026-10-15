-- Production migration version: 20261008102224.
create or replace function public.portal_record_purchase_business_decision(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare
  actor_is_active boolean := false;
  current_version integer;
  current_status text;
  requester uuid;
  route_tier text;
  request_row public.portal_purchase_request;
begin
  select exists (
    select 1 from public.portal_profile
    where id = p_actor_id and active and role = 'internal'
  ) into actor_is_active;
  if not actor_is_active then raise exception 'Active workforce account required'; end if;

  select r.version, r.status, r.requester_id, r.approval_tier
    into current_version, current_status, requester, route_tier
  from public.portal_purchase_request r where r.id = p_request_id for update;
  if current_version is null then raise exception 'Purchase request not found'; end if;
  if current_version <> p_expected_version then
    raise exception 'Purchase request changed (expected %, current %)', p_expected_version, current_version;
  end if;
  if current_status not in ('submitted','under_review','returned') then
    raise exception 'Purchase request is not awaiting business approval';
  end if;
  if p_decision not in ('approved','returned','denied') then
    raise exception 'Invalid business approval decision';
  end if;
  if length(btrim(coalesce(p_note,''))) < 8 then raise exception 'Business decision evidence required'; end if;
  if requester = p_actor_id then raise exception 'You cannot approve your own purchase request'; end if;
  if not exists (
    select 1 from public.portal_purchase_approver a
    where a.approval_tier = route_tier and a.active
      and a.approver_email = lower(btrim(coalesce(p_actor_email,'')))
  ) then raise exception 'You are not an assigned business approver for this request'; end if;

  update public.portal_purchase_request set
    business_approval_status = p_decision,
    business_approver_id = p_actor_id,
    business_approver_email = lower(btrim(p_actor_email)),
    business_approval_note = btrim(p_note), business_decided_at = now(),
    status = case when p_decision = 'approved' then 'under_review' else p_decision end
  where id = p_request_id returning * into request_row;
  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, 'under_review', p_actor_id, lower(btrim(p_actor_email)),
    'Business decision ' || p_decision || ': ' || btrim(p_note));
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_business_' || p_decision, request_row.id,
    jsonb_build_object('reference',request_row.reference,'approvalTier',request_row.approval_tier,
      'actorEmail',lower(btrim(p_actor_email)),'evidence',btrim(p_note)));
  select r.* into request_row from public.portal_purchase_request r where r.id = p_request_id;
  return request_row;
end;
$$;

create or replace function public.portal_decide_purchase_request(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare
  actor_is_admin boolean := false;
  current_version integer;
  current_status text;
  requester uuid;
  business_status text;
  request_row public.portal_purchase_request;
begin
  select exists (
    select 1 from public.portal_profile
    where id = p_actor_id and active and role = 'internal' and staff_role = 'administrator'
  ) into actor_is_admin;
  if not actor_is_admin then raise exception 'Administrator access required'; end if;

  select r.version, r.status, r.requester_id, r.business_approval_status
    into current_version, current_status, requester, business_status
  from public.portal_purchase_request r where r.id = p_request_id for update;
  if current_version is null then raise exception 'Purchase request not found'; end if;
  if current_version <> p_expected_version then
    raise exception 'Purchase request changed (expected %, current %)', p_expected_version, current_version;
  end if;
  if current_status not in ('submitted','under_review','returned','approved') then
    raise exception 'Purchase request is not reviewable';
  end if;
  if p_decision not in ('under_review','returned','approved','denied','completed') then
    raise exception 'Invalid purchase request decision';
  end if;
  if p_decision in ('returned','approved','denied','completed')
    and length(btrim(coalesce(p_note,''))) < 8 then raise exception 'Decision evidence required'; end if;
  if p_decision = 'approved' and requester = p_actor_id then
    raise exception 'You cannot approve your own purchase request';
  end if;
  if p_decision = 'approved' and business_status <> 'approved' then
    raise exception 'Required business approval has not been recorded';
  end if;
  if p_decision = 'completed' and current_status <> 'approved' then
    raise exception 'Only an approved purchase request can be completed';
  end if;

  update public.portal_purchase_request set status = p_decision,
    reviewer_id = p_actor_id, reviewer_email = nullif(lower(btrim(coalesce(p_actor_email,''))), ''),
    decision_note = nullif(btrim(coalesce(p_note,'')), ''),
    ordered_at = case when p_decision = 'completed' then coalesce(ordered_at,now()) else ordered_at end
  where id = p_request_id returning * into request_row;
  insert into public.portal_purchase_request_decision (
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (request_row.id, p_decision, p_actor_id,
    nullif(lower(btrim(coalesce(p_actor_email,''))), ''), nullif(btrim(coalesce(p_note,'')), ''));
  insert into public.portal_admin_audit (actor_id, action, target_id, detail)
  values (p_actor_id, 'purchase_request_' || p_decision, request_row.id, jsonb_build_object(
    'reference', request_row.reference, 'amount', request_row.amount,
    'approvalAuthority', request_row.approval_authority, 'evidence', request_row.decision_note,
    'actorEmail', nullif(lower(btrim(coalesce(p_actor_email,''))), '')));
  select r.* into request_row from public.portal_purchase_request r where r.id = p_request_id;
  return request_row;
end;
$$;

revoke all on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text)
  to service_role;
revoke all on function public.portal_decide_purchase_request(uuid,text,uuid,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.portal_decide_purchase_request(uuid,text,uuid,integer,text,text)
  to service_role;

comment on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text) is
  'Records a named business approval against the locked current request version and returns the authoritative post-trigger row.';
comment on function public.portal_decide_purchase_request(uuid,text,uuid,integer,text,text) is
  'Records the Administrator control decision against the locked current request version and returns the authoritative post-trigger row.';
