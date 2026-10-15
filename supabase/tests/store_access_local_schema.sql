-- Disposable test database only. This is NOT a production migration.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key,aud text,role text,email text,raw_app_meta_data jsonb,banned_until timestamptz);
create table portal_profile(id uuid primary key references auth.users,full_name text not null,org text not null,role text not null,active boolean not null default true,staff_role text);
create table portal_retailer_account(id uuid primary key,organization_name text not null,display_name text,portal_status text);
create table portal_organization(id uuid primary key,kind text,legal_name text,display_name text,status text,legacy_retailer_account_id uuid references portal_retailer_account);
create table portal_organization_membership(id uuid primary key,profile_id uuid references portal_profile,organization_id uuid references portal_organization,
  workspace text,member_role text,status text,is_default boolean default false,updated_at timestamptz default now());
create table portal_store(license_number text primary key,organization text,display_name text,retailer_account_id uuid references portal_retailer_account,
  active boolean,closed_at timestamptz,license_status text default 'pending_qualification' check(license_status in ('pending_qualification','active','expired','suspended','rejected')),license_expires_on date,ordering_status text default 'paused',approval_threshold_cents integer,
  enforce_case_quantity boolean default false,minimum_order_cents integer);
create table portal_profile_store(profile_id uuid references portal_profile,license_number text references portal_store,primary key(profile_id,license_number));
create table portal_admin_audit(id bigint generated always as identity,actor_id uuid,action text,target_id uuid,target_org text,detail jsonb);
create table portal_role_permission(staff_role text,permission text);
create table portal_store_price(id uuid,location_license text,product_id text,price_cents integer);
create table portal_receiving_claim(id uuid primary key,store_license text,state text,evidence_state text);
create table portal_price_proposal(id uuid default gen_random_uuid(),organization text,location_license text,product_id text,product_name text,sku text,current_price_cents integer,
  proposed_price_cents integer,note text,proposed_by uuid,proposed_by_email text,proposed_by_role text);
create table portal_receiving_claim_evidence(id uuid default gen_random_uuid(),claim_id uuid,evidence_kind text,object_path text,original_name text,content_type text,size_bytes integer,
  sha256 text,scan_state text,uploaded_by uuid,uploaded_by_email text,created_at timestamptz default now());
create table canix_sync_state(id integer,last_successful_at timestamptz,last_successful_run_id uuid);
create table canix_package_current(package_id bigint,sync_run_id uuid,facility_id bigint,item_id bigint,product_id bigint,
  quantity_type text,status_category text,weight numeric,orderable_units numeric,case_quantity numeric,test_result_status text,lab_test_status text,sales_order_id bigint);
create table canix_marketplace_sync_state(id integer,last_successful_run_id uuid,last_successful_at timestamptz,status text,snapshot_scope text);
create table canix_marketplace_product_snapshot(sync_run_id uuid,marketplace_product_id text,price_cents bigint);
create table portal_lot_integrity_state(id integer,enforcement_mode text);
create table portal_package_lot_control(package_id bigint,sync_run_id uuid,allocation_eligible boolean);
insert into portal_lot_integrity_state values(1,'monitor');
grant usage on schema public to anon,authenticated,service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
-- No service-role access to auth.users, matching the production boundary.
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000001','local-admin@example.invalid');
insert into portal_profile values('00000000-0000-4000-8000-000000000001','Local Admin','urbanXtracts','internal',true,'administrator');
insert into portal_organization values('00000000-0000-4000-8000-000000000002','internal','urbanXtracts','urbanXtracts','active',null);
insert into portal_organization_membership(id,profile_id,organization_id,workspace,member_role,status)
  values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','internal','administrator','active');
insert into portal_role_permission values('administrator','users.manage');
