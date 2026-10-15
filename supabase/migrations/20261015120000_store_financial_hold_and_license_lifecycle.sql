-- Approved Store account policy (Portal checklist 2026-10-15). Additive and rerun-safe.
-- * Payment terms: governed global default Net 30 plus at most one retailer-account
--   override inherited by every location. There is no location-level override.
-- * The only financial order block is an explicit, audited manual hold placed by
--   Finance or an Internal portal Administrator. Overdue invoices, balances and
--   QuickBooks freshness never create, clear or substitute for a hold.
-- * License activation, renewal and onboarding approval require Compliance,
--   Finance or an Internal portal Administrator with append-only evidence. A
--   verification names a clean uploaded license document by its UUID.
-- * Every portal_order insert pauses on missing, unverified, expired, inactive or
--   closed license scope (UXL01), independently of a financial hold (UXH01).
-- * Authorized billing user (store_billing): own-account invoices, balances,
--   payment history and terms only. Store access itself remains disabled. Scoped
--   Internal Administrator membership administration may grant it, account-wide
--   with no location assignment, exactly like the Owner's location scope.
-- * T-30 renewal reminders are planned as deduplicated intents only, each with an
--   authorized destination identity re-checked at send time. The account
--   recipient is the active Account Owner, else the designated main contact;
--   with neither, one deduplicated internal exception is recorded and no
--   recipient is guessed. The Internal Compliance recipient was confirmed and
--   reaffirmed on 2026-10-15. Delivery is disabled by constraint until
--   notification release approval.
-- * License-document access is tenant-scoped and every allowed read is audited.
-- Existing account terms are NOT migrated (decision pending). Nothing is sent.

-- Internal authority. Administrator means an active Internal Administrator
-- membership, not the staff_role column alone. Finance and Compliance are active
-- departments ('quality' is Quality and Compliance) of an active Internal member.
create or replace function public.portal_internal_control_role(p_actor_id uuid, p_scope text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  with member as (
    select p.id, p.staff_role, m.member_role from portal_profile p
    join portal_organization_membership m on m.profile_id = p.id and m.workspace = 'internal' and m.status = 'active'
    join portal_organization o on o.id = m.organization_id and o.kind = 'internal' and o.status = 'active'
    where p.id = p_actor_id and p.active and p.role = 'internal'
  ), departments as (
    select d.department_key from portal_profile_department d
    where d.profile_id = p_actor_id and d.status = 'active' and exists (select 1 from member)
  )
  select case
    when p_scope not in ('financial', 'license') then null
    when exists (select 1 from member where staff_role = 'administrator' and member_role = 'administrator') then 'administrator'
    when exists (select 1 from departments where department_key = 'finance') then 'finance'
    when p_scope = 'license' and exists (select 1 from departments where department_key = 'quality') then 'compliance'
  end;
$$;

-- Authorized billing user. Store-workspace only; it never holds a location
-- assignment (portal_check_membership_store rejects it) and reads account-level.
alter table public.portal_organization_membership drop constraint if exists portal_organization_membership_member_role_check;
alter table public.portal_organization_membership add constraint portal_organization_membership_member_role_check check (member_role in (
  'administrator', 'operations', 'sales', 'quality', 'viewer',
  'brand_owner', 'brand_manager', 'brand_contributor', 'brand_viewer',
  'store_owner', 'store_buyer', 'store_staff', 'store_billing'));
alter table public.portal_organization_membership drop constraint if exists portal_organization_membership_billing_workspace_check;
alter table public.portal_organization_membership add constraint portal_organization_membership_billing_workspace_check
  check (member_role <> 'store_billing' or workspace = 'store');

-- Same contract as 20261014215429 plus store_billing, which (like the Owner)
-- resolves every active location of its own retailer account and no other.
create or replace function public.portal_resolve_store_context(p_actor_id uuid, p_membership_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare m portal_organization_membership; o portal_organization; licenses jsonb;
begin
  if not exists(select 1 from portal_store_access_control where id and enabled) then
    raise exception 'Live Store access remains held' using errcode='42501';
  end if;
  if not exists(select 1 from portal_profile where id=p_actor_id and active) then
    raise exception 'Active identity required' using errcode='42501';
  end if;
  select * into m from portal_organization_membership where id=p_membership_id
    and profile_id=p_actor_id and workspace='store' and status='active';
  if not found or m.member_role not in ('store_owner','store_buyer','store_staff','store_billing') then
    raise exception 'Active Store membership required' using errcode='42501';
  end if;
  select * into o from portal_organization where id=m.organization_id and kind='retailer' and status='active';
  if not found or o.legacy_retailer_account_id is null then
    raise exception 'Verified retailer organization required' using errcode='42501';
  end if;
  if exists(select 1 from portal_membership_store a join portal_store s using(license_number)
    where a.membership_id=m.id and s.retailer_account_id is distinct from o.legacy_retailer_account_id) then
    raise exception 'Store assignments require reconciliation' using errcode='42501';
  end if;
  if m.member_role='store_staff' and (select count(*) from portal_membership_store where membership_id=m.id)<>1 then
    raise exception 'Budtender requires exactly one Store assignment' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(s.license_number order by s.license_number),'[]') into licenses
  from portal_store s where s.retailer_account_id=o.legacy_retailer_account_id and s.active and s.closed_at is null
    and (m.member_role in ('store_owner','store_billing') or exists(select 1 from portal_membership_store a
      where a.membership_id=m.id and a.license_number=s.license_number));
  return jsonb_build_object('actorId',p_actor_id,'membershipId',m.id,'organizationId',o.id,
    'retailerAccountId',o.legacy_retailer_account_id,'memberRole',m.member_role,'licenses',licenses);
end $$;

create table if not exists public.portal_payment_terms_default (
  id boolean primary key default true check (id),
  terms text not null check (length(btrim(terms)) between 1 and 80),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
insert into public.portal_payment_terms_default(id, terms) values (true, 'Net 30') on conflict (id) do nothing;

-- Primary key on the account: one override at most, and no location column.
create table if not exists public.portal_retailer_payment_terms (
  retailer_account_id uuid primary key references public.portal_retailer_account(id) on delete cascade,
  terms text not null check (length(btrim(terms)) between 1 and 80),
  set_by uuid not null references auth.users(id),
  set_at timestamptz not null default now()
);

create table if not exists public.portal_retailer_financial_hold (
  retailer_account_id uuid primary key references public.portal_retailer_account(id) on delete cascade,
  active boolean not null,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now()
);

-- Evidence keeps the verified document's UUID and digest, not a link, so it
-- survives document retention. xact_id binds an onboarding approval to the one
-- transaction that also advanced the request.
create table if not exists public.portal_store_control_event (
  id bigint generated always as identity primary key,
  control text not null check (control in ('payment_terms_default', 'payment_terms_override', 'financial_hold',
    'license_verification', 'onboarding_approval', 'reminder_recipient')),
  actor_id uuid not null references auth.users(id),
  internal_role text not null check (internal_role in ('administrator', 'finance', 'compliance')),
  retailer_account_id uuid references public.portal_retailer_account(id),
  license_number text,
  document_id uuid,
  document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$'),
  onboarding_request_id uuid,
  result text,
  prior_value jsonb not null,
  new_value jsonb not null,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  evidence text not null check (length(btrim(evidence)) between 1 and 2000),
  xact_id xid8 not null default pg_current_xact_id(),
  occurred_at timestamptz not null default now(),
  check (control not in ('payment_terms_override', 'financial_hold') or retailer_account_id is not null),
  check (control <> 'license_verification' or (license_number is not null and document_id is not null and document_sha256 is not null
    and onboarding_request_id is not null and result in ('verified', 'rejected'))),
  check (control <> 'onboarding_approval' or (onboarding_request_id is not null and result = 'approved' and prior_value ? 'stage'))
);
create index if not exists portal_store_control_event_account_idx on public.portal_store_control_event(retailer_account_id, occurred_at desc);
create index if not exists portal_store_control_event_license_idx on public.portal_store_control_event(license_number, control);
create index if not exists portal_store_control_event_request_idx on public.portal_store_control_event(onboarding_request_id) where onboarding_request_id is not null;

create table if not exists public.portal_license_reminder_config (
  id boolean primary key default true check (id),
  compliance_email text not null check (compliance_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  compliance_email_review text not null default 'reaffirmed' check (compliance_email_review in ('reaffirmed', 'replaced')),
  review_note text not null check (length(btrim(review_note)) between 1 and 2000),
  lead_days integer not null default 30 check (lead_days = 30),
  -- Delivery stays off until notification release approval changes this constraint.
  delivery_enabled boolean not null default false check (delivery_enabled = false),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);
-- Confirmed and reaffirmed by urbanXtracts on 2026-10-15 as the temporary
-- Internal Compliance recipient. A later change uses the audited Administrator
-- replacement below. Delivery remains disabled whatever the recipient.
insert into public.portal_license_reminder_config(id, compliance_email, compliance_email_review, review_note, reviewed_at)
values (true, 'tom@urbanxtracts.com', 'reaffirmed',
  'Confirmed and reaffirmed 2026-10-15 as the temporary Internal Compliance reminder recipient; delivery remains disabled.',
  '2026-10-15 00:00:00 America/New_York') on conflict (id) do nothing;

-- Every intent names the identity its channel reaches: a portal profile for
-- in-portal and Owner email (the Owner's email is resolved at send time), or a
-- governed address for the main-contact fallback and Internal Compliance email.
create table if not exists public.portal_license_renewal_reminder (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique,
  license_number text not null,
  retailer_account_id uuid references public.portal_retailer_account(id),
  license_expires_on date not null,
  due_on date not null,
  recipient_kind text not null check (recipient_kind in ('account_owner', 'main_contact', 'internal_compliance')),
  recipient_profile_id uuid references auth.users(id),
  recipient_email text check (recipient_email is null or recipient_email = lower(recipient_email)),
  channel text not null check (channel in ('email', 'in_portal')),
  delivery_state text not null default 'disabled_pending_release' check (delivery_state = 'disabled_pending_release'),
  created_at timestamptz not null default now(),
  check ((recipient_kind = 'account_owner' and recipient_profile_id is not null and recipient_email is null)
    or (recipient_kind = 'main_contact' and channel = 'email' and recipient_email is not null and recipient_profile_id is null)
    or (recipient_kind = 'internal_compliance' and channel = 'email' and recipient_email is not null and recipient_profile_id is null)
    or (recipient_kind = 'internal_compliance' and channel = 'in_portal' and recipient_profile_id is not null and recipient_email is null))
);

-- A due license whose account has neither an active Account Owner nor a valid
-- designated main contact. One row per license expiration; no account recipient
-- is guessed, and the row carries the action Internal staff must take.
create table if not exists public.portal_license_reminder_exception (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique,
  license_number text not null,
  retailer_account_id uuid references public.portal_retailer_account(id),
  license_expires_on date not null,
  due_on date not null,
  exception_kind text not null check (exception_kind = 'missing_account_recipient'),
  required_action text not null check (length(btrim(required_action)) between 1 and 2000),
  detected_at timestamptz not null default now()
);
create index if not exists portal_license_reminder_exception_account_idx on public.portal_license_reminder_exception(retailer_account_id, detected_at desc);

create table if not exists public.portal_license_document_access_event (
  id bigint generated always as identity primary key,
  document_id uuid not null,
  retailer_account_id uuid not null,
  actor_id uuid not null references auth.users(id),
  workspace text not null check (workspace in ('internal', 'store')),
  actor_role text not null check (actor_role in ('administrator', 'finance', 'compliance', 'store_owner')),
  access text not null check (access in ('read', 'download')),
  occurred_at timestamptz not null default now()
);
create index if not exists portal_license_document_access_event_doc_idx on public.portal_license_document_access_event(document_id, occurred_at desc);

create or replace function public.portal_reject_audit_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Audit history is append-only' using errcode = '42501';
end $$;
drop trigger if exists portal_store_control_event_append_only on public.portal_store_control_event;
create trigger portal_store_control_event_append_only before update or delete on public.portal_store_control_event
  for each row execute function public.portal_reject_audit_change();
drop trigger if exists portal_store_control_event_no_truncate on public.portal_store_control_event;
create trigger portal_store_control_event_no_truncate before truncate on public.portal_store_control_event
  for each statement execute function public.portal_reject_audit_change();
drop trigger if exists portal_license_reminder_exception_append_only on public.portal_license_reminder_exception;
create trigger portal_license_reminder_exception_append_only before update or delete on public.portal_license_reminder_exception
  for each row execute function public.portal_reject_audit_change();
drop trigger if exists portal_license_reminder_exception_no_truncate on public.portal_license_reminder_exception;
create trigger portal_license_reminder_exception_no_truncate before truncate on public.portal_license_reminder_exception
  for each statement execute function public.portal_reject_audit_change();
drop trigger if exists portal_license_document_access_append_only on public.portal_license_document_access_event;
create trigger portal_license_document_access_append_only before update or delete on public.portal_license_document_access_event
  for each row execute function public.portal_reject_audit_change();
drop trigger if exists portal_license_document_access_no_truncate on public.portal_license_document_access_event;
create trigger portal_license_document_access_no_truncate before truncate on public.portal_license_document_access_event
  for each statement execute function public.portal_reject_audit_change();

create or replace function public.portal_retailer_effective_payment_terms(p_account_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when o.terms is not null then jsonb_build_object('terms', o.terms, 'source', 'account_override')
    else jsonb_build_object('terms', d.terms, 'source', 'global_default') end
  from portal_payment_terms_default d left join portal_retailer_payment_terms o on o.retailer_account_id = p_account_id
  where d.id;
$$;

-- p_account_id null changes the global default; otherwise the account override.
-- A blank override clears it so every location inherits the default again.
create or replace function public.portal_set_payment_terms(p_actor_id uuid, p_account_id uuid, p_terms text, p_reason text, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare role_name text; prior jsonb; next_terms text := nullif(btrim(coalesce(p_terms, '')), '');
begin
  role_name := portal_internal_control_role(p_actor_id, 'financial');
  if role_name is null then
    raise exception 'Finance or an Internal portal Administrator is required to change payment terms' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null or nullif(btrim(coalesce(p_evidence, '')), '') is null
    or length(coalesce(next_terms, '')) > 80 then
    raise exception 'Payment terms require a reason and evidence reference' using errcode = '22023';
  end if;
  if p_account_id is null then
    if next_terms is null then raise exception 'The global default payment terms are required' using errcode = '22023'; end if;
    select jsonb_build_object('terms', terms) into strict prior from portal_payment_terms_default where id for update;
    if prior->>'terms' = next_terms then raise exception 'Those payment terms are already in effect' using errcode = '23514'; end if;
    update portal_payment_terms_default set terms = next_terms, updated_by = p_actor_id, updated_at = now() where id;
    insert into portal_store_control_event(control, actor_id, internal_role, prior_value, new_value, reason, evidence)
    values ('payment_terms_default', p_actor_id, role_name, prior, jsonb_build_object('terms', next_terms), btrim(p_reason), btrim(p_evidence));
    return jsonb_build_object('scope', 'global_default', 'terms', next_terms);
  end if;
  perform 1 from portal_retailer_account where id = p_account_id for update;
  if not found then raise exception 'Retailer account not found' using errcode = '22023'; end if;
  prior := portal_retailer_effective_payment_terms(p_account_id);
  if (next_terms is null and prior->>'source' = 'global_default') or (prior->>'source' = 'account_override' and prior->>'terms' = next_terms) then
    raise exception 'Those payment terms are already in effect' using errcode = '23514';
  end if;
  if next_terms is null then
    delete from portal_retailer_payment_terms where retailer_account_id = p_account_id;
  else
    insert into portal_retailer_payment_terms(retailer_account_id, terms, set_by) values (p_account_id, next_terms, p_actor_id)
    on conflict (retailer_account_id) do update set terms = excluded.terms, set_by = excluded.set_by, set_at = now();
  end if;
  insert into portal_store_control_event(control, actor_id, internal_role, retailer_account_id, prior_value, new_value, reason, evidence)
  values ('payment_terms_override', p_actor_id, role_name, p_account_id, prior, portal_retailer_effective_payment_terms(p_account_id),
    btrim(p_reason), btrim(p_evidence));
  return portal_retailer_effective_payment_terms(p_account_id) || jsonb_build_object('retailerAccountId', p_account_id);
end $$;

-- Explicit manual hold. QuickBooks refresh, payments and balances never call this.
create or replace function public.portal_set_financial_hold(p_actor_id uuid, p_account_id uuid, p_active boolean, p_reason text, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare role_name text; prior_active boolean;
begin
  role_name := portal_internal_control_role(p_actor_id, 'financial');
  if role_name is null then
    raise exception 'Finance or an Internal portal Administrator is required to change a financial hold' using errcode = '42501';
  end if;
  if p_active is null or nullif(btrim(coalesce(p_reason, '')), '') is null or nullif(btrim(coalesce(p_evidence, '')), '') is null then
    raise exception 'A financial hold change requires a reason and evidence reference' using errcode = '22023';
  end if;
  perform 1 from portal_retailer_account where id = p_account_id for update;
  if not found then raise exception 'Retailer account not found' using errcode = '22023'; end if;
  select active into prior_active from portal_retailer_financial_hold where retailer_account_id = p_account_id for update;
  if coalesce(prior_active, false) = p_active then
    raise exception 'The financial hold is already in that state' using errcode = '23514';
  end if;
  insert into portal_retailer_financial_hold(retailer_account_id, active, reason, changed_by) values (p_account_id, p_active, btrim(p_reason), p_actor_id)
  on conflict (retailer_account_id) do update set active = excluded.active, reason = excluded.reason, changed_by = excluded.changed_by, changed_at = now();
  insert into portal_store_control_event(control, actor_id, internal_role, retailer_account_id, prior_value, new_value, reason, evidence)
  values ('financial_hold', p_actor_id, role_name, p_account_id, jsonb_build_object('active', coalesce(prior_active, false)),
    jsonb_build_object('active', p_active), btrim(p_reason), btrim(p_evidence));
  return jsonb_build_object('retailerAccountId', p_account_id, 'active', p_active);
end $$;

-- Every order insert, whichever path created it, honours an active manual hold.
create or replace function public.portal_enforce_manual_financial_hold()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from portal_retailer_financial_hold h where h.active and h.retailer_account_id = coalesce(new.retailer_account_id,
      (select s.retailer_account_id from portal_store s where s.license_number = new.location_license))) then
    raise exception 'Ordering is on hold for this account' using errcode = 'UXH01';
  end if;
  return new;
end $$;
drop trigger if exists portal_order_manual_financial_hold on public.portal_order;
create trigger portal_order_manual_financial_hold before insert on public.portal_order
  for each row execute function public.portal_enforce_manual_financial_hold();

-- Ordering is allowed only at an active, open location whose license is active,
-- unexpired (valid through the expiration date, Eastern) and whose current
-- expiration was recorded by an authorized verification. A renewal upload alone
-- never satisfies this. UXL01 is distinct from the financial hold (UXH01).
create or replace function public.portal_assert_store_license_orderable(p_license text, p_account_id uuid default null)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
declare store portal_store;
begin
  select * into store from portal_store where license_number = p_license;
  if not found or store.active is not true or store.closed_at is not null or store.license_status is distinct from 'active'
    or store.license_expires_on is null or store.license_expires_on < (now() at time zone 'America/New_York')::date
    or (p_account_id is not null and store.retailer_account_id is distinct from p_account_id)
    or not exists (select 1 from portal_store_control_event e where e.control = 'license_verification' and e.result = 'verified'
      and e.license_number = upper(store.license_number) and e.new_value->>'licenseExpiresOn' = store.license_expires_on::text) then
    raise exception 'Ordering is paused for this location until a current store license is verified' using errcode = 'UXL01';
  end if;
end $$;

create or replace function public.portal_enforce_store_license_scope()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform portal_assert_store_license_orderable(new.location_license, new.retailer_account_id);
  return new;
end $$;
drop trigger if exists portal_order_license_scope on public.portal_order;
create trigger portal_order_license_scope before insert on public.portal_order
  for each row execute function public.portal_enforce_store_license_scope();

-- The Store command keeps its reviewed body (renamed once to _core). Order
-- creation authorizes the caller first, so license state is never disclosed
-- outside the caller's membership, then reports the distinct license pause.
-- An accepted request ID still returns its existing order on retry.
do $$
begin
  if to_regprocedure('public.portal_store_command_core(uuid,uuid,uuid,text,jsonb)') is null
    and to_regprocedure('public.portal_store_command(uuid,uuid,uuid,text,jsonb)') is not null then
    alter function public.portal_store_command(uuid, uuid, uuid, text, jsonb) rename to portal_store_command_core;
  end if;
end $$;
create or replace function public.portal_store_command(p_actor_id uuid, p_membership_id uuid, p_organization_id uuid, p_command text, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare license text;
begin
  if p_command = 'order.create' and jsonb_typeof(p_payload) = 'object' then
    license := coalesce(p_payload->>'p_location_license', p_payload->>'location_license');
    perform portal_lock_store_context(p_actor_id, p_membership_id, p_organization_id, license);
    if not exists (select 1 from portal_order where client_request_id = (p_payload->>'p_client_request_id')::uuid) then
      perform portal_assert_store_license_orderable(license);
    end if;
  end if;
  return portal_store_command_core(p_actor_id, p_membership_id, p_organization_id, p_command, p_payload);
end $$;

-- The uploaded onboarding document is the store's OCM license (the intake form
-- accepts only that document). A verification must name the document's UUID; it
-- must be clean, belong to the named onboarding request, that request must list
-- the license, and an existing store must belong to the request's retailer
-- account. Anything else is refused before any evidence is written.
drop function if exists public.portal_verify_store_license(uuid, text, text, text, date, text, uuid);
create or replace function public.portal_verify_store_license(p_actor_id uuid, p_license_number text, p_document_id uuid, p_result text,
  p_license_expires_on date, p_evidence text, p_onboarding_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare role_name text; normalized text := upper(btrim(coalesce(p_license_number, ''))); store portal_store; request portal_onboarding_request;
  doc portal_onboarding_document; account_id uuid; today date := (now() at time zone 'America/New_York')::date;
  mismatch constant text := 'The license document must be a clean OCM license upload for this onboarding request and license';
begin
  role_name := portal_internal_control_role(p_actor_id, 'license');
  if role_name is null then
    raise exception 'Compliance, Finance or an Internal portal Administrator must verify the license' using errcode = '42501';
  end if;
  if normalized = '' or p_document_id is null or p_onboarding_request_id is null or p_result is null or p_result not in ('verified', 'rejected')
    or nullif(btrim(coalesce(p_evidence, '')), '') is null then
    raise exception 'License verification requires the license, document, result and evidence' using errcode = '22023';
  end if;
  if p_result = 'verified' and (p_license_expires_on is null or p_license_expires_on <= today) then
    raise exception 'A current license expiration date is required' using errcode = '22023';
  end if;
  select * into request from portal_onboarding_request where id = p_onboarding_request_id for update;
  if not found then raise exception '%', mismatch using errcode = '22023'; end if;
  select * into doc from portal_onboarding_document where id = p_document_id for share;
  if not found or doc.onboarding_request_id is distinct from request.id or doc.scan_state is distinct from 'clean' then
    raise exception '%', mismatch using errcode = '22023';
  end if;
  if not exists (select 1 from portal_onboarding_store os where os.onboarding_request_id = request.id
      and upper(btrim(os.license_number)) = normalized) then
    raise exception '%', mismatch using errcode = '22023';
  end if;
  select * into store from portal_store where license_number = normalized for update;
  if store.license_number is not null and (request.retailer_account_id is null
      or store.retailer_account_id is distinct from request.retailer_account_id) then
    raise exception '%', mismatch using errcode = '22023';
  end if;
  account_id := coalesce(store.retailer_account_id, request.retailer_account_id);
  insert into portal_store_control_event(control, actor_id, internal_role, retailer_account_id, license_number, document_id, document_sha256,
    onboarding_request_id, result, prior_value, new_value, reason, evidence)
  values ('license_verification', p_actor_id, role_name, account_id, normalized, doc.id, doc.sha256, request.id, p_result,
    jsonb_build_object('licenseStatus', store.license_status, 'licenseExpiresOn', store.license_expires_on),
    jsonb_build_object('result', p_result, 'licenseExpiresOn', case when p_result = 'verified' then p_license_expires_on end),
    'License verification', btrim(p_evidence));
  if p_result = 'verified' and store.license_number is not null then
    update portal_store set license_status = 'active', license_expires_on = p_license_expires_on where license_number = normalized;
  end if;
  return jsonb_build_object('licenseNumber', normalized, 'result', p_result, 'licenseExpiresOn', p_license_expires_on,
    'documentId', doc.id, 'onboardingRequestId', request.id);
end $$;

-- An upload, Sales edit or any other path cannot activate or extend a license
-- unless an authorized verification recorded that exact expiration.
create or replace function public.portal_require_verified_license_activation()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.license_status = 'active' and (tg_op = 'INSERT' or old.license_status is distinct from 'active'
      or old.license_expires_on is distinct from new.license_expires_on) then
    if new.license_expires_on is null or not exists (select 1 from portal_store_control_event e
        where e.control = 'license_verification' and e.result = 'verified' and e.license_number = upper(new.license_number)
          and e.new_value->>'licenseExpiresOn' = new.license_expires_on::text) then
      raise exception 'License activation requires an authorized, audited verification of this expiration' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists portal_store_verified_license_activation on public.portal_store;
create trigger portal_store_verified_license_activation before insert or update of license_status, license_expires_on on public.portal_store
  for each row execute function public.portal_require_verified_license_activation();

-- Final onboarding approval and the transition to ready are one transaction.
-- The request must be at exactly the pre-ready stage the reviewer saw, every
-- qualified license must be a current active store of this account whose
-- expiration was verified against this request's document, and the approval
-- event is bound to the prior stage. If the transition fails, the approval
-- event rolls back with it.
drop function if exists public.portal_approve_store_onboarding(uuid, uuid, text);
create or replace function public.portal_complete_store_onboarding(p_actor_id uuid, p_request_id uuid, p_expected_stage text,
  p_evidence text, p_actor_email text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare role_name text; request portal_onboarding_request; qualified integer; unverified integer; result jsonb;
  today date := (now() at time zone 'America/New_York')::date;
begin
  role_name := portal_internal_control_role(p_actor_id, 'license');
  if role_name is null then
    raise exception 'Compliance, Finance or an Internal portal Administrator must approve onboarding' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_evidence, '')), '') is null then
    raise exception 'Onboarding approval requires evidence' using errcode = '22023';
  end if;
  select * into request from portal_onboarding_request where id = p_request_id for update;
  if not found then raise exception 'Onboarding request not found' using errcode = '22023'; end if;
  if request.stage is distinct from 'access' then
    raise exception 'Onboarding must be at the access stage before final approval' using errcode = '23514';
  end if;
  if p_expected_stage is distinct from request.stage then
    raise exception 'Onboarding must be at the access stage you reviewed; refresh before approving' using errcode = '40001';
  end if;
  select count(*) into qualified from portal_onboarding_store os
    where os.onboarding_request_id = request.id and os.qualification_status = 'qualified';
  select count(*) into unverified from portal_onboarding_store os
    where os.onboarding_request_id = request.id and os.qualification_status = 'qualified'
      and not exists (select 1 from portal_store s where s.license_number = upper(btrim(os.license_number))
        and s.retailer_account_id = request.retailer_account_id and s.active and s.closed_at is null
        and s.license_status = 'active' and s.license_expires_on >= today
        and exists (select 1 from portal_store_control_event e where e.control = 'license_verification' and e.result = 'verified'
          and e.license_number = s.license_number and e.onboarding_request_id = request.id
          and e.new_value->>'licenseExpiresOn' = s.license_expires_on::text));
  if qualified < 1 or unverified > 0 then
    raise exception 'Every qualified license needs a current audited verification from this onboarding request' using errcode = '23514';
  end if;
  insert into portal_store_control_event(control, actor_id, internal_role, retailer_account_id, onboarding_request_id, result,
    prior_value, new_value, reason, evidence)
  values ('onboarding_approval', p_actor_id, role_name, request.retailer_account_id, request.id, 'approved',
    jsonb_build_object('stage', request.stage, 'updatedAt', request.updated_at), jsonb_build_object('stage', 'ready'),
    'Onboarding approval', btrim(p_evidence));
  result := portal_advance_onboarding_request(request.id, 'ready', btrim(p_evidence), p_actor_id, p_actor_email);
  return coalesce(result, '{}'::jsonb) || jsonb_build_object('requestId', request.id, 'approvedBy', role_name);
end $$;

-- ready requires an approval written in this same transaction for this request
-- and bound to the stage being left; a historical approval never qualifies.
create or replace function public.portal_require_onboarding_approval()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stage = 'ready' and old.stage is distinct from 'ready' and not exists (select 1 from portal_store_control_event e
      where e.control = 'onboarding_approval' and e.onboarding_request_id = new.id and e.xact_id = pg_current_xact_id()
        and e.prior_value->>'stage' = old.stage) then
    raise exception 'Onboarding approval by Compliance, Finance or an Internal portal Administrator is required' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists portal_onboarding_request_requires_approval on public.portal_onboarding_request;
create trigger portal_onboarding_request_requires_approval before update of stage on public.portal_onboarding_request
  for each row execute function public.portal_require_onboarding_approval();

-- Designated main contact. Its current source is the legacy column
-- portal_retailer_account.account_owner_email: a contact address only, never
-- proof that an Account Owner exists. It is a reminder fallback only while the
-- account has no active Account Owner.
create or replace function public.portal_license_reminder_main_contact(p_account_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select lower(btrim(a.account_owner_email)) from portal_retailer_account a
  where a.id = p_account_id and lower(btrim(coalesce(a.account_owner_email, ''))) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
$$;

create or replace function public.portal_license_reminder_owner_active(p_account_id uuid, p_profile_id uuid default null)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from portal_organization o
    join portal_organization_membership m on m.organization_id = o.id and m.workspace = 'store' and m.member_role = 'store_owner' and m.status = 'active'
    join portal_profile p on p.id = m.profile_id and p.active
    where o.legacy_retailer_account_id = p_account_id and o.kind = 'retailer' and o.status = 'active'
      and (p_profile_id is null or m.profile_id = p_profile_id));
$$;

-- In-portal Internal Compliance reaches the portal identity of the governed
-- Compliance address, only while it holds license control authority.
create or replace function public.portal_license_reminder_compliance_profile()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select p.id from portal_license_reminder_config c
  join auth.users u on lower(u.email) = lower(c.compliance_email)
  join portal_profile p on p.id = u.id
  where c.id and portal_internal_control_role(p.id, 'license') is not null
  order by p.id limit 1;
$$;

create or replace function public.portal_plan_license_renewal_reminders(p_today date default (now() at time zone 'America/New_York')::date)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg portal_license_reminder_config; compliance_profile uuid; inserted integer;
begin
  select * into strict cfg from portal_license_reminder_config where id;
  compliance_profile := portal_license_reminder_compliance_profile();
  with due as (
    select s.license_number, s.retailer_account_id, s.license_expires_on, s.license_expires_on - cfg.lead_days as due_on
    from portal_store s
    where s.active and s.closed_at is null and s.license_expires_on is not null
      and p_today between s.license_expires_on - cfg.lead_days and s.license_expires_on
  ), owners as (
    select distinct d.*, m.profile_id from due d
    join portal_organization o on o.legacy_retailer_account_id = d.retailer_account_id and o.kind = 'retailer' and o.status = 'active'
    join portal_organization_membership m on m.organization_id = o.id and m.workspace = 'store'
      and m.member_role = 'store_owner' and m.status = 'active'
    join portal_profile p on p.id = m.profile_id and p.active
  ), recipients as (
    select o.license_number, o.retailer_account_id, o.license_expires_on, o.due_on, 'account_owner'::text as kind,
      o.profile_id, null::text as email, c.channel, o.profile_id::text as recipient_key
    from owners o cross join (values ('email'), ('in_portal')) as c(channel)
    union all
    select d.*, 'main_contact', null, portal_license_reminder_main_contact(d.retailer_account_id), 'email',
      portal_license_reminder_main_contact(d.retailer_account_id)
    from due d where not exists (select 1 from owners o where o.license_number = d.license_number)
      and portal_license_reminder_main_contact(d.retailer_account_id) is not null
    union all
    select d.*, 'internal_compliance', null, lower(cfg.compliance_email), 'email', lower(cfg.compliance_email) from due d
    union all
    select d.*, 'internal_compliance', compliance_profile, null, 'in_portal', compliance_profile::text from due d
    where compliance_profile is not null
  )
  insert into portal_license_renewal_reminder(dedupe_key, license_number, retailer_account_id, license_expires_on, due_on,
    recipient_kind, recipient_profile_id, recipient_email, channel)
  select concat_ws(':', 'license-renewal', r.license_number, r.license_expires_on, r.kind, r.recipient_key, r.channel),
    r.license_number, r.retailer_account_id, r.license_expires_on, r.due_on, r.kind, r.profile_id, r.email, r.channel
  from recipients r
  on conflict (dedupe_key) do nothing;
  get diagnostics inserted = row_count;
  -- Neither an active Owner nor a valid designated main contact: record one
  -- actionable exception instead of guessing a Buyer, Billing user or Budtender.
  insert into portal_license_reminder_exception(dedupe_key, license_number, retailer_account_id, license_expires_on, due_on,
    exception_kind, required_action)
  select concat_ws(':', 'license-renewal-exception', s.license_number, s.license_expires_on, 'missing_account_recipient'),
    s.license_number, s.retailer_account_id, s.license_expires_on, s.license_expires_on - cfg.lead_days, 'missing_account_recipient',
    'Add an active Store Owner, or record a valid designated main contact for this account. No account reminder was planned and no recipient was guessed.'
  from portal_store s
  where s.active and s.closed_at is null and s.license_expires_on is not null
    and p_today between s.license_expires_on - cfg.lead_days and s.license_expires_on
    and (s.retailer_account_id is null or (not portal_license_reminder_owner_active(s.retailer_account_id)
      and portal_license_reminder_main_contact(s.retailer_account_id) is null))
  on conflict (dedupe_key) do nothing;
  return inserted;
end $$;

-- Send-time decision for a future sender. Re-checks the recipient's current
-- authority and resolves the destination; delivery stays off regardless.
create or replace function public.portal_license_reminder_send_decision(p_reminder_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r portal_license_renewal_reminder; cfg portal_license_reminder_config; authorized boolean; reason text; destination text;
begin
  select * into r from portal_license_renewal_reminder where id = p_reminder_id;
  if not found then raise exception 'Reminder not found' using errcode = '22023'; end if;
  select * into strict cfg from portal_license_reminder_config where id;
  authorized := case r.recipient_kind
    when 'account_owner' then portal_license_reminder_owner_active(r.retailer_account_id, r.recipient_profile_id)
    when 'main_contact' then not portal_license_reminder_owner_active(r.retailer_account_id)
      and portal_license_reminder_main_contact(r.retailer_account_id) = r.recipient_email
    else case r.channel when 'email' then r.recipient_email = lower(cfg.compliance_email)
      else r.recipient_profile_id is not distinct from portal_license_reminder_compliance_profile() end
  end;
  if authorized then
    destination := case when r.channel = 'in_portal' then r.recipient_profile_id::text
      when r.recipient_kind = 'account_owner' then (select lower(u.email) from auth.users u where u.id = r.recipient_profile_id)
      else r.recipient_email end;
    authorized := destination is not null;
  end if;
  reason := case when not authorized then
      case when r.recipient_kind = 'main_contact' and portal_license_reminder_owner_active(r.retailer_account_id)
        then 'superseded_by_account_owner' else 'recipient_no_longer_authorized' end
    when not cfg.delivery_enabled or r.delivery_state = 'disabled_pending_release' then 'delivery_disabled_pending_release' end;
  return jsonb_build_object('reminderId', r.id, 'send', false, 'reason', reason, 'recipientAuthorized', authorized,
    'channel', r.channel, 'destination', case when authorized then destination end);
end $$;

-- The daily preparation job keeps calling this name. It now plans approved
-- intents (Owner or designated main-contact fallback, and Internal Compliance)
-- plus missing-recipient exceptions, and queues nothing for delivery; the
-- previous Owner-and-Buyer outbox rows are no longer created.
create or replace function public.portal_queue_license_notifications()
returns integer language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  return public.portal_plan_license_renewal_reminders();
end $$;

create or replace function public.portal_set_license_reminder_recipient(p_actor_id uuid, p_email text, p_review text, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare role_name text; prior portal_license_reminder_config;
begin
  role_name := portal_internal_control_role(p_actor_id, 'license');
  if role_name is distinct from 'administrator' then
    raise exception 'An Internal portal Administrator must record the Compliance recipient review' using errcode = '42501';
  end if;
  if p_review not in ('reaffirmed', 'replaced') or nullif(btrim(coalesce(p_evidence, '')), '') is null then
    raise exception 'Record whether the recipient was reaffirmed or replaced, with evidence' using errcode = '22023';
  end if;
  select * into strict prior from portal_license_reminder_config where id for update;
  if p_review = 'reaffirmed' and lower(btrim(coalesce(p_email, ''))) <> lower(prior.compliance_email) then
    raise exception 'A reaffirmation must keep the current recipient' using errcode = '22023';
  end if;
  if p_review = 'replaced' and lower(btrim(coalesce(p_email, ''))) = lower(prior.compliance_email) then
    raise exception 'A replacement must name a different recipient' using errcode = '22023';
  end if;
  update portal_license_reminder_config set compliance_email = lower(btrim(p_email)), compliance_email_review = p_review,
    review_note = btrim(p_evidence), reviewed_by = p_actor_id, reviewed_at = now(), updated_at = now() where id;
  insert into portal_store_control_event(control, actor_id, internal_role, prior_value, new_value, reason, evidence)
  values ('reminder_recipient', p_actor_id, role_name, jsonb_build_object('email', prior.compliance_email, 'review', prior.compliance_email_review),
    jsonb_build_object('email', lower(btrim(p_email)), 'review', p_review), 'Compliance recipient review', btrim(p_evidence));
  return jsonb_build_object('email', lower(btrim(p_email)), 'review', p_review, 'deliveryEnabled', false);
end $$;

-- Owning Account Owner plus Internal Compliance, Finance and portal Administrators
-- only. Buyers, Budtenders, billing users, other accounts and guessed IDs are
-- denied alike. Only a clean document stored at its exact archive path
-- (<request>/<sha256>.<ext>) is released; the caller signs a short-lived URL.
create or replace function public.portal_authorize_license_document(p_actor_id uuid, p_membership_id uuid, p_document_id uuid, p_access text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare doc record; c jsonb; role_name text; workspace_name text := 'internal';
begin
  if p_access is null or p_access not in ('read', 'download') then raise exception 'Unsupported document access' using errcode = '22023'; end if;
  select d.id, d.onboarding_request_id, d.object_path, d.original_name, d.content_type, d.scan_state, d.sha256, r.retailer_account_id into doc
  from portal_onboarding_document d join portal_onboarding_request r on r.id = d.onboarding_request_id where d.id = p_document_id;
  if not found or doc.retailer_account_id is null or doc.scan_state is distinct from 'clean'
    or doc.object_path is distinct from doc.onboarding_request_id::text || '/' || doc.sha256 || '.'
      || (case doc.content_type when 'application/pdf' then 'pdf' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' end) then
    raise exception 'Document is outside your access' using errcode = '42501';
  end if;
  role_name := portal_internal_control_role(p_actor_id, 'license');
  if role_name is null then
    if p_membership_id is null then raise exception 'Document is outside your access' using errcode = '42501'; end if;
    c := portal_resolve_store_context(p_actor_id, p_membership_id);
    if c->>'memberRole' is distinct from 'store_owner' or (c->>'retailerAccountId')::uuid is distinct from doc.retailer_account_id then
      raise exception 'Document is outside your access' using errcode = '42501';
    end if;
    role_name := 'store_owner'; workspace_name := 'store';
  end if;
  insert into portal_license_document_access_event(document_id, retailer_account_id, actor_id, workspace, actor_role, access)
  values (doc.id, doc.retailer_account_id, p_actor_id, workspace_name, role_name, p_access);
  return jsonb_build_object('documentId', doc.id, 'onboardingRequestId', doc.onboarding_request_id, 'sha256', doc.sha256,
    'objectPath', doc.object_path, 'originalName', doc.original_name, 'contentType', doc.content_type);
end $$;

-- Demo allowlist for the warning-only finance, manual hold and license actions.
create or replace function public.portal_commit_store_demo(p_actor_id uuid,p_revision integer,p_state jsonb,p_action text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare current_revision integer; result_revision integer;
begin
  if not exists(select 1 from portal_store_demo_control where id and enabled) then
    raise exception 'Store demonstration is paused' using errcode='42501';
  end if;
  if not exists (
    select 1 from portal_profile p
    join portal_organization_membership m on m.profile_id=p.id
    join portal_organization o on o.id=m.organization_id
    join portal_role_permission r on r.staff_role=p.staff_role and r.permission='store.demo'
    where p.id=p_actor_id and p.active and p.role='internal' and p.staff_role='administrator'
      and m.workspace='internal' and m.member_role='administrator' and m.status='active' and o.status='active'
  ) then raise exception 'Internal Administrator required' using errcode='42501'; end if;
  if p_revision < 0 or p_revision is null or jsonb_typeof(p_state) is distinct from 'object'
    or octet_length(p_state::text)>400000 or p_action not in (
      'reset','save-section','submit-section','review-section','save-draft','submit-order','transition-order',
      'set-terms','place-hold','release-hold','simulate-accounting','upload-renewal','verify-license'
    ) then raise exception 'Invalid demonstration update' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('store-demo:'||p_actor_id::text,0));
  select revision into current_revision from portal_store_demo_session where actor_id=p_actor_id for update;
  if coalesce(current_revision,0)<>p_revision then
    raise exception 'Demonstration changed; refresh before saving' using errcode='40001';
  end if;
  result_revision:=p_revision+1;
  insert into portal_store_demo_session(actor_id,revision,state) values(p_actor_id,result_revision,p_state)
    on conflict(actor_id) do update set revision=excluded.revision,state=excluded.state,updated_at=now();
  insert into portal_admin_audit(actor_id,actor_org,action,target_org,detail)
  values(p_actor_id,'urbanXtracts','store_demo.'||p_action,'urbanXtracts Store',
    jsonb_build_object('synthetic',true,'revision',result_revision,'outboundEffects','suppressed'));
  return jsonb_build_object('revision',result_revision);
end $$;

-- Scoped membership administration (20261014223749), unchanged except that an
-- Internal Administrator may also grant store_billing. Billing resolves every
-- active location of its own account (as above) and is refused any location
-- assignment, so it gains no ordering, document or administration authority;
-- Store Owners still revoke only Buyers and Budtenders. No Auth change or mail.
create or replace function public.portal_manage_store_membership(
  p_actor_id uuid,p_actor_membership_id uuid,p_organization_id uuid,p_profile_id uuid,
  p_membership_id uuid,p_member_role text,p_licenses text[],p_status text,
  p_expected_updated_at timestamptz,p_reason text,p_request_id uuid,
  p_verified_identities jsonb,p_verified_at timestamptz
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare target portal_organization_membership; account_id uuid; before_value jsonb;
  licenses text[]; fingerprint text; prior portal_store_membership_change; response jsonb; member_id uuid;
begin
  perform 1 from portal_store_access_control where id and enabled for share;
  if not found then raise exception 'Live Store access remains held' using errcode='42501'; end if;
  perform 1 from portal_organization_membership m join portal_profile p on p.id=m.profile_id
    join portal_organization o on o.id=m.organization_id
    where m.id=p_actor_membership_id and m.profile_id=p_actor_id and m.workspace='internal'
      and m.member_role='administrator' and m.status='active' and p.active and o.kind='internal' and o.status='active'
    for share of m,p,o;
  if not found then raise exception 'Current Internal Administrator membership required' using errcode='42501'; end if;
  perform 1 from portal_role_permission where staff_role='administrator' and permission='users.manage' for share;
  if not found then raise exception 'User administration authority required' using errcode='42501'; end if;
  if p_actor_id=p_profile_id or p_request_id is null or nullif(btrim(p_reason),'') is null or length(p_reason)>1000
    or p_status is null or p_status not in ('active','disabled')
    or p_member_role is null or p_member_role not in ('store_owner','store_buyer','store_staff','store_billing') then
    raise exception 'An explicit role, status, reason and non-self target are required' using errcode='22023';
  end if;
  -- One person cannot gain concurrent membership of two retailer organizations.
  perform pg_advisory_xact_lock(hashtextextended('store-person:'||p_profile_id,0));
  perform pg_advisory_xact_lock(hashtextextended('store-membership:'||p_organization_id,0));
  select legacy_retailer_account_id into account_id from portal_organization
    where id=p_organization_id and kind='retailer' and status='active' for share;
  if account_id is null then raise exception 'Verified active retailer required' using errcode='42501'; end if;
  perform 1 from portal_profile where id=p_profile_id and active for share;
  if not found then raise exception 'An active existing portal identity is required' using errcode='42501'; end if;
  select coalesce(array_agg(distinct v order by v),'{}'::text[]) into licenses from unnest(coalesce(p_licenses,'{}')) v;
  if cardinality(licenses)<>cardinality(coalesce(p_licenses,'{}')) then
    raise exception 'Duplicate location assignments are not allowed' using errcode='22023'; end if;
  fingerprint:=md5(jsonb_build_object('actor',p_actor_id,'org',p_organization_id,'profile',p_profile_id,
    'membership',p_membership_id,'role',p_member_role,'licenses',licenses,'status',p_status,
    'expected',p_expected_updated_at,'reason',btrim(p_reason))::text);
  select * into prior from portal_store_membership_change where id=p_request_id;
  if found then
    if prior.actor_id<>p_actor_id or prior.organization_id<>p_organization_id or prior.fingerprint<>fingerprint then
      raise exception 'Request identifier reused with different access changes' using errcode='40001'; end if;
    return prior.result||jsonb_build_object('idempotent',true);
  end if;
  if p_verified_at is null or p_verified_at>clock_timestamp()+interval '2 seconds'
    or p_verified_at<clock_timestamp()-interval '30 seconds' or jsonb_typeof(p_verified_identities) is distinct from 'array' then
    raise exception 'Fresh server identity verification required' using errcode='40001'; end if;
  if p_status='active' and not exists(select 1 from jsonb_to_recordset(p_verified_identities) v(id uuid,eligible boolean,"expiresOn" date)
    where v.id=p_profile_id and v.eligible and (v."expiresOn" is null or v."expiresOn">=(clock_timestamp() at time zone 'America/New_York')::date)) then
    raise exception 'Target identity is expired or unavailable' using errcode='42501'; end if;
  if not exists(select 1 from jsonb_to_recordset(p_verified_identities) v(id uuid,eligible boolean,"expiresOn" date)
    where v.id=p_actor_id and v.eligible and (v."expiresOn" is null or v."expiresOn">=(clock_timestamp() at time zone 'America/New_York')::date)) then
    raise exception 'Administrator identity is expired or unavailable' using errcode='42501'; end if;
  select * into target from portal_organization_membership where profile_id=p_profile_id and organization_id=p_organization_id and workspace='store' for update;
  if found then
    if p_membership_id is distinct from target.id or p_expected_updated_at is distinct from target.updated_at then
      raise exception 'Membership changed; reload before saving' using errcode='40001'; end if;
  elsif p_membership_id is not null or p_expected_updated_at is not null or p_status<>'active' then
    raise exception 'Membership target requires review' using errcode='40001';
  end if;
  if p_status='active' and exists(select 1 from portal_organization_membership where profile_id=p_profile_id
    and workspace='store' and status in ('active','invited') and organization_id<>p_organization_id) then
    raise exception 'This person already belongs to another retailer' using errcode='23514'; end if;
  -- Billing is account-wide like the Owner: it never holds a location assignment.
  if p_status='active' and ((p_member_role in ('store_owner','store_billing') and cardinality(licenses)<>0)
    or (p_member_role='store_buyer' and cardinality(licenses) not between 1 and 25)
    or (p_member_role='store_staff' and cardinality(licenses)<>1)) then
    raise exception 'Owner and Billing use all stores; Buyer needs assignments; Budtender needs exactly one' using errcode='23514'; end if;
  perform 1 from portal_store where license_number=any(licenses) for share;
  if exists(select 1 from unnest(licenses) v where not exists(select 1 from portal_store s
    where s.license_number=v and s.retailer_account_id=account_id and s.active and s.closed_at is null)) then
    raise exception 'Location is outside the active retailer scope' using errcode='42501'; end if;
  -- Serialize Owner changes and consider current Auth eligibility, not merely
  -- a still-active profile belonging to an expired contractor.
  perform 1 from portal_organization_membership m join portal_profile p on p.id=m.profile_id
    where m.organization_id=p_organization_id and m.workspace='store' and m.member_role='store_owner' and m.status='active'
    for share of m,p;
  if target.member_role='store_owner' and target.status='active' and (p_member_role<>'store_owner' or p_status<>'active')
    and not exists(select 1 from portal_organization_membership m join portal_profile p on p.id=m.profile_id
      join jsonb_to_recordset(p_verified_identities) v(id uuid,eligible boolean,"expiresOn" date) on v.id=m.profile_id
      where m.organization_id=p_organization_id and m.workspace='store' and m.member_role='store_owner' and m.status='active'
        and p.active and m.id<>target.id and v.eligible
        and (v."expiresOn" is null or v."expiresOn">=(clock_timestamp() at time zone 'America/New_York')::date)) then
    raise exception 'Add an eligible replacement Owner before removing or demoting this Owner' using errcode='23514'; end if;
  before_value:=case when target.id is null then null else to_jsonb(target)||jsonb_build_object('licenses',
    (select coalesce(jsonb_agg(license_number order by license_number),'[]') from portal_membership_store where membership_id=target.id)) end;
  member_id:=coalesce(target.id,gen_random_uuid());
  -- Remove old assignments before a role change; none are inferred from names.
  delete from portal_membership_store where membership_id=member_id;
  if target.id is null then
    insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status,is_default)
      values(member_id,p_profile_id,p_organization_id,'store',p_member_role,p_status,false);
  else
    update portal_organization_membership set member_role=p_member_role,status=p_status,
      is_default=case when p_status='disabled' then false else is_default end,updated_at=clock_timestamp() where id=member_id;
  end if;
  if p_status='active' then
    insert into portal_membership_store(membership_id,license_number) select member_id,v from unnest(licenses) v;
  end if;
  response:=jsonb_build_object('membershipId',member_id,'organizationId',p_organization_id,'profileId',p_profile_id,
    'memberRole',p_member_role,'status',p_status,'licenses',case when p_status='active' then to_jsonb(licenses) else '[]'::jsonb end,
    'globalAccountChanged',false,'emailSent',false);
  insert into portal_admin_audit(actor_id,action,target_id,detail) values(p_actor_id,'manage-store-membership',p_profile_id,
    jsonb_build_object('actorMembershipId',p_actor_membership_id,'organizationId',p_organization_id,'membershipId',member_id,
      'before',before_value,'after',response,'reason',btrim(p_reason),'requestId',p_request_id));
  insert into portal_store_membership_change(id,actor_id,organization_id,fingerprint,result)
    values(p_request_id,p_actor_id,p_organization_id,fingerprint,response);
  return response;
end $$;

alter table public.portal_payment_terms_default enable row level security;
alter table public.portal_retailer_payment_terms enable row level security;
alter table public.portal_retailer_financial_hold enable row level security;
alter table public.portal_store_control_event enable row level security;
alter table public.portal_license_reminder_config enable row level security;
alter table public.portal_license_renewal_reminder enable row level security;
alter table public.portal_license_document_access_event enable row level security;
alter table public.portal_license_reminder_exception enable row level security;
revoke all on public.portal_payment_terms_default, public.portal_retailer_payment_terms, public.portal_retailer_financial_hold,
  public.portal_store_control_event, public.portal_license_reminder_config, public.portal_license_renewal_reminder,
  public.portal_license_document_access_event, public.portal_license_reminder_exception from public, anon, authenticated, service_role;
-- Read-only to server functions. Every write goes through an audited function.
grant select on public.portal_payment_terms_default, public.portal_retailer_payment_terms, public.portal_retailer_financial_hold,
  public.portal_store_control_event, public.portal_license_reminder_config, public.portal_license_renewal_reminder,
  public.portal_license_document_access_event, public.portal_license_reminder_exception to service_role;

revoke all on function public.portal_internal_control_role(uuid, text) from public, anon, authenticated;
revoke all on function public.portal_resolve_store_context(uuid, uuid) from public, anon, authenticated;
revoke all on function public.portal_retailer_effective_payment_terms(uuid) from public, anon, authenticated;
revoke all on function public.portal_set_payment_terms(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.portal_set_financial_hold(uuid, uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.portal_assert_store_license_orderable(text, uuid) from public, anon, authenticated;
revoke all on function public.portal_store_command(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.portal_store_command_core(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.portal_verify_store_license(uuid, text, uuid, text, date, text, uuid) from public, anon, authenticated;
revoke all on function public.portal_complete_store_onboarding(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.portal_license_reminder_main_contact(uuid) from public, anon, authenticated;
revoke all on function public.portal_license_reminder_owner_active(uuid, uuid) from public, anon, authenticated;
revoke all on function public.portal_license_reminder_compliance_profile() from public, anon, authenticated;
revoke all on function public.portal_plan_license_renewal_reminders(date) from public, anon, authenticated;
revoke all on function public.portal_license_reminder_send_decision(bigint) from public, anon, authenticated;
revoke all on function public.portal_set_license_reminder_recipient(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.portal_authorize_license_document(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_reject_audit_change() from public, anon, authenticated;
revoke all on function public.portal_enforce_manual_financial_hold() from public, anon, authenticated;
revoke all on function public.portal_enforce_store_license_scope() from public, anon, authenticated;
revoke all on function public.portal_require_verified_license_activation() from public, anon, authenticated;
revoke all on function public.portal_require_onboarding_approval() from public, anon, authenticated;
revoke all on function public.portal_queue_license_notifications() from public, anon, authenticated;
revoke all on function public.portal_commit_store_demo(uuid, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.portal_manage_store_membership(uuid,uuid,uuid,uuid,uuid,text,text[],text,timestamptz,text,uuid,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.portal_internal_control_role(uuid, text) to service_role;
grant execute on function public.portal_resolve_store_context(uuid, uuid) to service_role;
grant execute on function public.portal_retailer_effective_payment_terms(uuid) to service_role;
grant execute on function public.portal_set_payment_terms(uuid, uuid, text, text, text) to service_role;
grant execute on function public.portal_set_financial_hold(uuid, uuid, boolean, text, text) to service_role;
grant execute on function public.portal_assert_store_license_orderable(text, uuid) to service_role;
grant execute on function public.portal_store_command(uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.portal_store_command_core(uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.portal_verify_store_license(uuid, text, uuid, text, date, text, uuid) to service_role;
grant execute on function public.portal_complete_store_onboarding(uuid, uuid, text, text, text) to service_role;
grant execute on function public.portal_plan_license_renewal_reminders(date) to service_role;
grant execute on function public.portal_license_reminder_send_decision(bigint) to service_role;
grant execute on function public.portal_set_license_reminder_recipient(uuid, text, text, text) to service_role;
grant execute on function public.portal_authorize_license_document(uuid, uuid, uuid, text) to service_role;
grant execute on function public.portal_queue_license_notifications() to service_role;
grant execute on function public.portal_commit_store_demo(uuid, integer, jsonb, text) to service_role;
grant execute on function public.portal_manage_store_membership(uuid,uuid,uuid,uuid,uuid,text,text[],text,timestamptz,text,uuid,jsonb,timestamptz) to service_role;
