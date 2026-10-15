-- Coordinated Store endpoint release. Historical rows remain untouched and
-- unavailable externally until a reviewed stable retailer mapping is recorded.
-- Retire direct legacy profile/RLS access, not just the old UI/API path.
-- Internal and Brand consumers use their protected server endpoints; no new
-- browser grant or permissive policy is added for these Store tables.
revoke all on public.portal_store,public.portal_profile_store,public.portal_order,public.portal_order_line,
  public.portal_order_event,public.portal_price_proposal,public.portal_store_price,public.portal_receiving_claim,
  public.portal_receiving_claim_evidence,public.portal_inventory_commitment from public,anon,authenticated;
alter table public.portal_order add column retailer_account_id uuid references public.portal_retailer_account(id);
alter table public.portal_receiving_claim add column retailer_account_id uuid references public.portal_retailer_account(id);
create index portal_order_retailer_scope_idx on public.portal_order(retailer_account_id,location_license);
create index portal_claim_retailer_scope_idx on public.portal_receiving_claim(retailer_account_id,store_license);

create function public.portal_lock_store_context(p_actor_id uuid,p_membership_id uuid,p_organization_id uuid,p_license text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare c jsonb;
begin
  -- Same lock as membership revocation; a committed revocation wins over any
  -- waiting mutation. Control/profile/membership/location locks last to commit.
  perform pg_advisory_xact_lock(hashtextextended('store-membership:'||p_organization_id,0));
  perform 1 from portal_store_access_control where id for share;
  perform 1 from portal_profile where id=p_actor_id for share;
  perform 1 from portal_organization_membership where id=p_membership_id for share;
  perform 1 from portal_organization where id=p_organization_id for share;
  perform 1 from portal_store where license_number=p_license for share;
  perform 1 from portal_membership_store where membership_id=p_membership_id for share;
  c:=portal_resolve_store_context(p_actor_id,p_membership_id);
  if c->>'organizationId'<>p_organization_id::text or not (c->'licenses' ? p_license)
    or c->>'memberRole' not in ('store_owner','store_buyer') then
    raise exception 'Current Store membership does not authorize this operation' using errcode='42501';
  end if;
  return c;
end $$;
revoke all on function public.portal_lock_store_context(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.portal_lock_store_context(uuid,uuid,uuid,text) to service_role;

-- One facility-scoped calculation shared by catalog quantities and commit.
-- Legacy commitments without facility attribution are counted conservatively.
create function public.portal_store_available_units(p_item_id bigint,p_run uuid)
returns numeric language sql stable security invoker set search_path=public,pg_temp as $$
  with mode as (select coalesce((select enforcement_mode from portal_lot_integrity_state where id=1),'block') as value),
  packages as (select p.* from canix_package_current p cross join mode
    where p.sync_run_id=p_run and p.facility_id=4467 and p.item_id=p_item_id and p.quantity_type='CountBased'
      and regexp_replace(lower(coalesce(p.test_result_status,p.lab_test_status,'')),'[^a-z0-9]+','','g')<>'testfailed'
      and (mode.value<>'block' or exists(select 1 from portal_package_lot_control c where c.package_id=p.package_id and c.sync_run_id=p_run and c.allocation_eligible))),
  pool as (select coalesce(sum(greatest(coalesce(orderable_units,weight,0),0)),0) as quantity from packages where status_category='available'),
  uncovered as (select coalesce(sum(greatest(c.quantity-coalesce(coverage.quantity,0),0)),0) as quantity
    from portal_inventory_commitment c join portal_order o on o.id=c.order_id
    left join lateral(select sum(greatest(coalesce(p.weight,0),0)) as quantity from packages p
      where p.status_category='allocated' and p.sales_order_id=o.canix_sales_order_id) coverage on o.canix_sales_order_id is not null
    where c.active and c.product_id='canix:item:'||p_item_id)
  select greatest(floor(pool.quantity-uncovered.quantity),0) from pool cross join uncovered;
$$;
revoke all on function public.portal_store_available_units(bigint,uuid) from public,anon,authenticated;
grant execute on function public.portal_store_available_units(bigint,uuid) to service_role;

create function public.portal_store_request_fingerprint(p_actor uuid,p_account uuid,p_license text,p_payload jsonb)
returns text language sql immutable security invoker set search_path=public,pg_temp as $$
  select md5(jsonb_build_object('actor',p_actor,'account',p_account,'license',p_license,
    'reference',p_payload->>'p_portal_reference','delivery',p_payload->>'p_delivery_window',
    'contact',p_payload->>'p_receiving_contact','instructions',p_payload->>'p_receiving_instructions',
    'lines',(select jsonb_agg(jsonb_build_object('product',value->>'productId','quantity',(value->>'quantity')::integer,
      'price',(value->>'unitPriceCents')::integer) order by value->>'productId',ordinality)
      from jsonb_array_elements(p_payload->'p_lines') with ordinality))::text);
$$;
revoke all on function public.portal_store_request_fingerprint(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.portal_store_request_fingerprint(uuid,uuid,text,jsonb) to service_role;

create function public.portal_store_command(p_actor_id uuid,p_membership_id uuid,p_organization_id uuid,p_command text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare c jsonb; license text; account_id uuid; account_name text; role_name text; result jsonb;
  target_order portal_order; target_claim portal_receiving_claim; proposal portal_price_proposal;
  snapshot_at timestamptz; snapshot_run uuid; target_state text; approval boolean; threshold integer; total integer;
  shop_run uuid; shop_at timestamptz; shop_status text; shop_scope text; line jsonb; item_id_value bigint;
  product_ids text[]; match_count integer; price integer; case_sizes integer[]; enforce_case boolean; minimum_cents integer;
  request_fingerprint text; existing_order portal_order;
begin
  if p_command is null or p_command not in ('order.create','order.transition','price.propose','claim.create','claim.evidence')
    or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Unsupported Store command' using errcode='22023'; end if;
  if p_command in ('order.transition','claim.create') then
    select * into target_order from portal_order where id=(p_payload->>'p_order_id')::uuid;
    if not found then raise exception 'Order is outside your access' using errcode='42501'; end if;
    license:=target_order.location_license;
  elsif p_command='claim.evidence' then
    select * into target_claim from portal_receiving_claim where id=(p_payload->>'claim_id')::uuid;
    if not found then raise exception 'Claim is outside your access' using errcode='42501'; end if;
    license:=target_claim.store_license;
  else license:=coalesce(p_payload->>'p_location_license',p_payload->>'location_license'); end if;
  c:=portal_lock_store_context(p_actor_id,p_membership_id,p_organization_id,license);
  account_id:=(c->>'retailerAccountId')::uuid;
  role_name:=case c->>'memberRole' when 'store_owner' then 'owner' else 'buyer' end;
  select organization_name into strict account_name from portal_retailer_account where id=account_id for share;
  if p_command in ('order.transition','claim.create') and target_order.retailer_account_id is distinct from account_id then
    raise exception 'Order retailer relationship requires review' using errcode='42501';
  end if;
  if p_command='claim.evidence' and target_claim.retailer_account_id is distinct from account_id then
    raise exception 'Claim retailer relationship requires review' using errcode='42501';
  end if;
  if p_command='order.create' then
    request_fingerprint:=portal_store_request_fingerprint(p_actor_id,account_id,license,p_payload);
    select * into existing_order from portal_order where client_request_id=(p_payload->>'p_client_request_id')::uuid for update;
    if found then
      if existing_order.retailer_account_id is distinct from account_id or existing_order.submitted_by is distinct from p_actor_id
        or existing_order.metadata->>'storeRequestFingerprint' is distinct from request_fingerprint then
        raise exception 'The request identifier belongs to a different verified order' using errcode='40001';
      end if;
      return jsonb_build_object('id',existing_order.id,'created',false,'workflowState',existing_order.workflow_state,
        'orderNumber',existing_order.order_number,'portalReference',existing_order.portal_reference,'state',existing_order.state);
    end if;
    select last_successful_at,last_successful_run_id into snapshot_at,snapshot_run from canix_sync_state where id=1 for share;
    if snapshot_run is null or snapshot_at is null or snapshot_at>clock_timestamp() or clock_timestamp()-snapshot_at>interval '5 minutes' then
      raise exception 'Canix inventory is stale; draft preserved' using errcode='40001';
    end if;
    select last_successful_run_id,last_successful_at,status,snapshot_scope into shop_run,shop_at,shop_status,shop_scope
      from canix_marketplace_sync_state where id=1 for share;
    if shop_run is null or shop_at is null or shop_at>clock_timestamp() or clock_timestamp()-shop_at>interval '7 days'
      or shop_status is distinct from 'success' or shop_scope is distinct from 'full_shop' then
      raise exception 'Marketplace publication is not current; draft preserved' using errcode='40001';
    end if;
    if not exists(select 1 from portal_store where license_number=license and retailer_account_id=account_id
      and active and closed_at is null and license_status='active' and license_expires_on>=(now() at time zone 'America/New_York')::date and ordering_status='ready')
      or not exists(select 1 from portal_retailer_account where id=account_id and portal_status='ready_to_order') then
      raise exception 'Retailer or Store ordering is not ready' using errcode='42501';
    end if;
    select approval_threshold_cents,enforce_case_quantity,minimum_order_cents into threshold,enforce_case,minimum_cents from portal_store where license_number=license;
    total:=(p_payload->>'p_order_value_cents')::integer;
    if minimum_cents is not null and total<minimum_cents then raise exception 'Store minimum changed; draft preserved' using errcode='40001'; end if;
    -- Publish is low volume in the beta. A short SHARE lock prevents a new
    -- Store override being inserted between a default-price read and commit.
    lock table portal_store_price in share mode;
    for line in select value from jsonb_array_elements(p_payload->'p_lines') order by value->>'productId' loop
      if coalesce(line->>'productId','') !~ '^canix:item:[1-9][0-9]*$' then
        raise exception 'An approved canonical Canix item is required' using errcode='22023';
      end if;
      item_id_value:=split_part(line->>'productId',':',3)::bigint;
      perform pg_advisory_xact_lock(hashtextextended('canix:item:'||item_id_value,0));
      if (select sum((x.value->>'quantity')::integer) from jsonb_array_elements(p_payload->'p_lines') x(value)
          where x.value->>'productId'=line->>'productId')>portal_store_available_units(item_id_value,snapshot_run) then
        raise exception 'Requested quantity exceeds facility availability after active portal commitments' using errcode='40001';
      end if;
      select array_agg(distinct product_id::text),array_agg(distinct case_quantity::integer) filter(where case_quantity>0)
        into product_ids,case_sizes from canix_package_current
        where sync_run_id=snapshot_run and facility_id=4467 and quantity_type='CountBased' and status_category='available'
          and item_id=item_id_value and coalesce(orderable_units,weight)>0
          and regexp_replace(lower(coalesce(test_result_status,lab_test_status,'')),'[^a-z0-9]+','','g')<>'testfailed';
      if coalesce(cardinality(product_ids),0)<>1 then raise exception 'Item publication is ambiguous; draft preserved' using errcode='40001'; end if;
      select count(distinct item_id) into match_count from canix_package_current
        where sync_run_id=snapshot_run and facility_id=4467 and quantity_type='CountBased' and status_category='available'
          and product_id::text=product_ids[1] and coalesce(orderable_units,weight)>0
          and regexp_replace(lower(coalesce(test_result_status,lab_test_status,'')),'[^a-z0-9]+','','g')<>'testfailed';
      if match_count<>1 then raise exception 'Marketplace item identity requires review' using errcode='40001'; end if;
      if enforce_case and (coalesce(cardinality(case_sizes),0)<>1 or (line->>'quantity')::integer%case_sizes[1]<>0) then
        raise exception 'Case quantity changed; draft preserved' using errcode='40001';
      end if;
      select price_cents::integer into price from portal_store_price
        where location_license=license and product_id in (line->>'productId','canix-item-'||item_id_value)
        order by (product_id=line->>'productId') desc limit 1;
      if not found then select price_cents::integer into price from canix_marketplace_product_snapshot
        where sync_run_id=shop_run and marketplace_product_id=product_ids[1]; end if;
      if price is null or price<=0 or price<>(line->>'unitPriceCents')::integer then
        raise exception 'Published price changed; draft preserved' using errcode='40001';
      end if;
    end loop;
    approval:=role_name='buyer' and threshold is not null and (threshold=0 or total>threshold);
    result:=portal_create_order(
      (p_payload->>'p_client_request_id')::uuid,p_payload->>'p_portal_reference',account_name,license,p_payload->>'p_location_name',
      p_actor_id,p_payload->>'p_submitted_by_email',role_name,case when approval then 'awaiting_owner_approval' else 'ordered' end,
      approval,threshold,total,(p_payload->>'p_contains_preorder')::boolean,(p_payload->>'p_release_hold')::boolean,
      p_payload->>'p_delivery_window',p_payload->>'p_receiving_contact',p_payload->>'p_receiving_instructions',p_payload->'p_lines',
      coalesce(p_payload->'p_metadata','{}')||jsonb_build_object('membershipId',p_membership_id,'retailerAccountId',account_id,'storeRequestFingerprint',request_fingerprint));
    update portal_order set retailer_account_id=account_id where id=(result->>'id')::uuid
      and (retailer_account_id is null or retailer_account_id=account_id);
    return result;
  elsif p_command='order.transition' then
    target_state:=p_payload->>'p_target_state';
    if not ((role_name='owner' and target_order.state='awaiting_owner_approval' and target_state in ('ordered','declined')
        and target_order.submitted_by<>p_actor_id) or (target_order.state='processed' and target_state='delivered')) then
      raise exception 'This Store role cannot make that order transition' using errcode='42501';
    end if;
    return portal_apply_order_transition(target_order.id,p_payload->>'p_expected_state',target_state,p_actor_id,
      p_payload->>'p_actor_email',case role_name when 'owner' then 'store-owner' else 'store-user' end,p_payload->>'p_note',null,
      jsonb_build_object('membershipId',p_membership_id,'retailerAccountId',account_id),null,false);
  elsif p_command='price.propose' then
    insert into portal_price_proposal(organization,location_license,product_id,product_name,sku,current_price_cents,
      proposed_price_cents,note,proposed_by,proposed_by_email,proposed_by_role)
    values(account_name,license,p_payload->>'product_id',p_payload->>'product_name',p_payload->>'sku',
      (p_payload->>'current_price_cents')::integer,(p_payload->>'proposed_price_cents')::integer,p_payload->>'note',
      p_actor_id,p_payload->>'proposed_by_email',role_name) returning * into proposal;
    insert into portal_admin_audit(actor_id,action,target_org,detail) values(p_actor_id,'price-proposed',account_name,
      jsonb_build_object('membershipId',p_membership_id,'proposalId',proposal.id,'retailerAccountId',account_id));
    return to_jsonb(proposal);
  elsif p_command='claim.create' then
    result:=portal_create_receiving_claim(target_order.id,(p_payload->>'p_order_line_id')::bigint,account_name,license,
      p_payload->>'p_claim_type',(p_payload->>'p_quantity')::integer,p_payload->>'p_narrative',p_actor_id,p_payload->>'p_submitted_by_email',null,null);
    update portal_receiving_claim set retailer_account_id=account_id where id=(result->>'id')::uuid;
    return result||jsonb_build_object('retailer_account_id',account_id);
  else
    if target_claim.state in ('approved','denied','closed','withdrawn') or p_payload->>'scan_state' is distinct from 'clean'
      or p_payload->>'object_path' is null or p_payload->>'object_path' not like target_claim.id::text||'/%' then
      raise exception 'Evidence cannot be accepted for this claim' using errcode='42501';
    end if;
    insert into portal_receiving_claim_evidence(claim_id,evidence_kind,object_path,original_name,content_type,size_bytes,sha256,
      scan_state,uploaded_by,uploaded_by_email) values(target_claim.id,p_payload->>'evidence_kind',p_payload->>'object_path',
      p_payload->>'original_name',p_payload->>'content_type',(p_payload->>'size_bytes')::integer,p_payload->>'sha256','clean',p_actor_id,p_payload->>'uploaded_by_email') returning to_jsonb(portal_receiving_claim_evidence.*) into result;
    update portal_receiving_claim set evidence_state='clean',state=case when state='more_information' then 'submitted' else state end where id=target_claim.id;
    return jsonb_build_object('id',result->'id','evidence_kind',result->'evidence_kind','original_name',result->'original_name','created_at',result->'created_at');
  end if;
end $$;
revoke all on function public.portal_store_command(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.portal_store_command(uuid,uuid,uuid,text,jsonb) to service_role;
