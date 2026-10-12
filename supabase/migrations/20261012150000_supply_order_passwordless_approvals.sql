-- Passwordless, single-decision Supply Order approvals. Raw capability tokens
-- are never persisted: only their SHA-256 digest is stored. Each link expires
-- after 72 hours and the first valid decision revokes every sibling link.

alter table public.portal_purchase_request
  add column if not exists business_approver_name text;

alter table public.portal_purchase_request_decision
  alter column actor_id drop not null;
alter table public.portal_purchase_request_decision
  drop constraint if exists portal_purchase_request_decision_decision_check;
alter table public.portal_purchase_request_decision
  add constraint portal_purchase_request_decision_decision_check check (decision in (
    'submitted','under_review','returned','approved','awaiting_order','ordered',
    'partially_received','received','denied','completed','cancelled'
  ));

create table if not exists public.portal_purchase_approval_link (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.portal_purchase_request(id) on delete cascade,
  approval_tier text not null check (approval_tier in ('eric_500','leadership_2999','eran_3000')),
  approver_name text not null check (length(btrim(approver_name)) between 2 and 160),
  approver_email text not null check (approver_email = lower(btrim(approver_email)) and position('@' in approver_email) > 1),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  decision text check (decision is null or decision in ('approved','denied')),
  decision_note text,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((consumed_at is null and decision is null) or (consumed_at is not null and decision is not null))
);

create index if not exists portal_purchase_approval_link_request_idx
  on public.portal_purchase_approval_link (purchase_request_id, expires_at desc);
create index if not exists portal_purchase_approval_link_active_idx
  on public.portal_purchase_approval_link (token_hash, expires_at)
  where consumed_at is null and revoked_at is null;

alter table public.portal_purchase_approval_link enable row level security;
revoke all on table public.portal_purchase_approval_link from public, anon, authenticated;
grant all on table public.portal_purchase_approval_link to service_role;

create or replace function public.portal_decide_purchase_by_token(
  p_token_hash text,
  p_decision text,
  p_note text default null
) returns public.portal_purchase_request
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  link_row public.portal_purchase_approval_link;
  request_row public.portal_purchase_request;
  evidence text;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Approval link is invalid';
  end if;
  if p_decision not in ('approved','denied') then
    raise exception 'Invalid approval decision';
  end if;
  if p_decision = 'denied' and length(btrim(coalesce(p_note,''))) < 8 then
    raise exception 'A rejection reason is required';
  end if;

  select * into link_row
  from public.portal_purchase_approval_link
  where token_hash = p_token_hash
  for update;
  if link_row.id is null then raise exception 'Approval link is invalid'; end if;
  if link_row.expires_at <= now() then raise exception 'Approval link has expired'; end if;
  if link_row.consumed_at is not null or link_row.revoked_at is not null then
    raise exception 'Approval link has already been used';
  end if;

  select * into request_row
  from public.portal_purchase_request
  where id = link_row.purchase_request_id
  for update;
  if request_row.id is null then raise exception 'Supply order not found'; end if;
  if request_row.status not in ('submitted','under_review','returned')
    or request_row.business_approval_status = 'approved' then
    raise exception 'Supply order is no longer awaiting approval';
  end if;

  evidence := case when p_decision = 'approved'
    then coalesce(nullif(btrim(p_note),''), 'Approved through the secure email link.')
    else btrim(p_note) end;

  update public.portal_purchase_request set
    business_approval_status = p_decision,
    business_approver_id = null,
    business_approver_name = link_row.approver_name,
    business_approver_email = link_row.approver_email,
    business_approval_note = evidence,
    business_decided_at = now(),
    status = case when p_decision = 'approved' then 'awaiting_order' else 'denied' end
  where id = request_row.id
  returning * into request_row;

  update public.portal_purchase_approval_link set
    consumed_at = now(), decision = p_decision, decision_note = evidence
  where id = link_row.id;
  update public.portal_purchase_approval_link set revoked_at = now()
  where purchase_request_id = request_row.id and id <> link_row.id
    and consumed_at is null and revoked_at is null;

  insert into public.portal_purchase_request_decision(
    purchase_request_id, decision, actor_id, actor_email, evidence_note
  ) values (
    request_row.id,
    case when p_decision = 'approved' then 'awaiting_order' else 'denied' end,
    null,
    link_row.approver_email,
    'Secure email decision by ' || link_row.approver_name || ': ' || evidence
  );
  insert into public.portal_admin_audit(actor_id,action,target_id,detail)
  -- portal_admin_audit predates passwordless actors and requires a UUID. The
  -- approval-link ID is the immutable actor handle; human attribution remains
  -- in actorName/actorEmail and in the decision ledger.
  values(link_row.id,'supply_order_business_'||p_decision,request_row.id,jsonb_build_object(
    'reference',request_row.reference,
    'approvalTier',request_row.approval_tier,
    'actorName',link_row.approver_name,
    'actorEmail',link_row.approver_email,
    'decisionSource','secure_email_link',
    'evidence',evidence));
  return request_row;
end;
$$;

revoke all on function public.portal_decide_purchase_by_token(text,text,text) from public,anon,authenticated;
grant execute on function public.portal_decide_purchase_by_token(text,text,text) to service_role;

-- Keep the signed-in Portal approval path aligned with the email path and
-- capture the human-readable approver name for every surface.
create or replace function public.portal_record_purchase_business_decision(
  p_actor_id uuid, p_actor_email text, p_request_id uuid, p_expected_version integer,
  p_decision text, p_note text
) returns public.portal_purchase_request
language plpgsql set search_path = public, pg_temp as $$
declare current_version integer; current_status text; requester uuid; route_tier text;
  request_row public.portal_purchase_request; actor_name text;
begin
  select full_name into actor_name from public.portal_profile
    where id=p_actor_id and active and role='internal';
  if actor_name is null then raise exception 'Active workforce account required'; end if;
  select version,status,requester_id,approval_tier into current_version,current_status,requester,route_tier
  from public.portal_purchase_request where id=p_request_id for update;
  if current_version is null then raise exception 'Purchase request not found'; end if;
  if current_version <> p_expected_version then raise exception 'Purchase request changed'; end if;
  if current_status not in ('submitted','under_review','returned') then raise exception 'Purchase request is not awaiting business approval'; end if;
  if p_decision not in ('approved','returned','denied') then raise exception 'Invalid business approval decision'; end if;
  if length(btrim(coalesce(p_note,''))) < 8 then raise exception 'Business decision evidence required'; end if;
  if requester = p_actor_id then raise exception 'You cannot approve your own purchase request'; end if;
  if not exists (select 1 from public.portal_purchase_approver where approval_tier=route_tier and active and approver_email=lower(btrim(coalesce(p_actor_email,'')))) then
    raise exception 'You are not an assigned business approver for this request';
  end if;
  update public.portal_purchase_request set
    business_approval_status=p_decision, business_approver_id=p_actor_id,
    business_approver_name=actor_name, business_approver_email=lower(btrim(p_actor_email)),
    business_approval_note=btrim(p_note), business_decided_at=now(),
    status=case when p_decision='approved' then 'awaiting_order' else p_decision end
  where id=p_request_id returning * into request_row;
  update public.portal_purchase_approval_link set revoked_at=now()
    where purchase_request_id=request_row.id and consumed_at is null and revoked_at is null;
  insert into public.portal_purchase_request_decision(purchase_request_id,decision,actor_id,actor_email,evidence_note)
  values(request_row.id,case when p_decision='approved' then 'awaiting_order' else p_decision end,p_actor_id,lower(btrim(p_actor_email)),'Business decision '||p_decision||' by '||actor_name||': '||btrim(p_note));
  insert into public.portal_admin_audit(actor_id,action,target_id,detail)
  values(p_actor_id,'supply_order_business_'||p_decision,request_row.id,jsonb_build_object('reference',request_row.reference,'approvalTier',request_row.approval_tier,'actorName',actor_name,'actorEmail',lower(btrim(p_actor_email)),'decisionSource','signed_in_portal','evidence',btrim(p_note)));
  return request_row;
end;
$$;

revoke all on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.portal_record_purchase_business_decision(uuid,text,uuid,integer,text,text) to service_role;

insert into public.portal_notification_template(
  template_key,title,audience,category,mandatory,default_channels,
  subject_template,text_template,allowed_variables,approval_state,version
) values (
  'purchase_request_approval_required','Supply order approval','internal','account',true,array['email'],
  'Approval needed: {{requestReference}} · {{amount}}',
  E'Hello {{recipientName}},\n\nA Supply Order needs your decision. This personal link expires in 72 hours. The first valid decision completes approval.\n\nReference: {{requestReference}}\nRequester: {{requesterName}} ({{requesterEmail}})\nDepartment: {{departmentName}}\nBrand: {{brandName}}\nVendor: {{vendorName}}\nPurpose: {{purpose}}\nPriority: {{priority}}\nNeeded by: {{neededBy}}\nItems:\n{{lineItems}}\n\nMerchandise: {{merchandiseSubtotal}}\nShipping: {{shipping}}\nTax: {{tax}}\nDiscount: {{discount}}\nTotal: {{amount}}\nRecipient: {{deliveryRecipient}}\nDestination: {{deliveryLocation}}\nAuthority: {{approvalAuthority}}\nExpires: {{expiresAt}}\n\nApprove: {{approveUrl}}\nReject: {{rejectUrl}}\n\nDo not forward these personal approval links.',
  array['recipientName','requestReference','requesterName','requesterEmail','departmentName','brandName','vendorName','purpose','priority','neededBy','lineItems','merchandiseSubtotal','shipping','tax','discount','amount','deliveryRecipient','deliveryLocation','approvalAuthority','expiresAt','approveUrl','rejectUrl'],
  'approved',2
) on conflict(template_key) do update set
  title=excluded.title,audience=excluded.audience,category=excluded.category,
  mandatory=excluded.mandatory,default_channels=excluded.default_channels,
  subject_template=excluded.subject_template,text_template=excluded.text_template,
  allowed_variables=excluded.allowed_variables,approval_state='approved',
  version=greatest(public.portal_notification_template.version+1,excluded.version),updated_at=now();

comment on table public.portal_purchase_approval_link is
  'Hashed, 72-hour, single-use Supply Order approval capabilities. Raw tokens are never stored.';
