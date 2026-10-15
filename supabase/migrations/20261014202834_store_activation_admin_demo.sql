-- Controlled synthetic Store demonstration. No live memberships or source IDs.
create table public.portal_store_demo_control (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.portal_store_demo_control(id,enabled) values(true,false);
create table public.portal_store_demo_session (
  actor_id uuid primary key references public.portal_profile(id),
  revision integer not null check(revision > 0),
  state jsonb not null check(jsonb_typeof(state)='object'),
  updated_at timestamptz not null default now()
);
alter table public.portal_store_demo_control enable row level security;
alter table public.portal_store_demo_session enable row level security;
revoke all on public.portal_store_demo_control, public.portal_store_demo_session from public,anon,authenticated;
grant select,insert,update on public.portal_store_demo_control, public.portal_store_demo_session to service_role;
do $$
declare rule record;
begin
  select conname,pg_get_constraintdef(oid) definition into strict rule from pg_constraint
    where conrelid='public.portal_role_permission'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%permission%';
  if rule.definition not like '%store.demo%' then
    execute format('alter table public.portal_role_permission drop constraint %I',rule.conname);
    execute format('alter table public.portal_role_permission add constraint %I %s',rule.conname,
      replace(rule.definition,'''sku_intake.manage''::text','''sku_intake.manage''::text, ''store.demo''::text'));
  end if;
end $$;
insert into public.portal_role_permission(staff_role,permission)
values('administrator','store.demo') on conflict do nothing;

-- Service-only, atomic CAS + audit. Actor privileges and the emergency kill
-- switch are rechecked after the Edge authentication and before every commit.
create function public.portal_commit_store_demo(p_actor_id uuid,p_revision integer,p_state jsonb,p_action text)
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
      'reset','save-section','submit-section','review-section','finance-review','save-draft','submit-order','transition-order'
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
revoke all on function public.portal_commit_store_demo(uuid,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.portal_commit_store_demo(uuid,integer,jsonb,text) to service_role;

-- Change only the known legacy limit expressions in the current function
-- definitions; retain later accounting, qualification and idempotency fixes.
do $$
declare name text; fn regprocedure; definition text;
begin
  foreach name in array array['portal_add_retailer_store','portal_create_onboarding_request'] loop
    select p.oid::regprocedure into strict fn from pg_proc p
      where p.pronamespace='public'::regnamespace and p.proname=name;
    definition:=pg_get_functiondef(fn);
    definition:=replace(replace(replace(replace(definition,
      'store_count >= 10','store_count >= 25'),
      'jsonb_array_length(p_stores) > 10','jsonb_array_length(p_stores) > 25'),
      'no more than ten stores','no more than 25 stores'),
      'between one and ten stores','between one and 25 stores');
    execute definition;
  end loop;
end $$;
create or replace function public.portal_enforce_retailer_store_limit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare open_store_count integer;
begin
  if new.retailer_account_id is null or new.closed_at is not null then return new; end if;
  if tg_op='UPDATE' then
    if old.retailer_account_id is not distinct from new.retailer_account_id and old.closed_at is null then return new; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.retailer_account_id::text,0));
  select count(*) into open_store_count from portal_store
    where retailer_account_id=new.retailer_account_id and closed_at is null
      and license_number<>new.license_number;
  if open_store_count>=25 then raise exception 'A retailer account may contain no more than 25 stores'; end if;
  return new;
end $$;
revoke all on function public.portal_enforce_retailer_store_limit() from public,anon,authenticated;
drop trigger portal_store_limit_trigger on public.portal_store;
create trigger portal_store_limit_trigger before insert or update of retailer_account_id,closed_at
  on public.portal_store for each row execute function public.portal_enforce_retailer_store_limit();
