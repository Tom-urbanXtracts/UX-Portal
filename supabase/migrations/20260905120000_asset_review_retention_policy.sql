-- Final fail-closed review and retention policy for portal-managed catalog
-- assets. Product images remain on hold until an approved scanner is wired;
-- this migration governs any existing records and the future reviewed path.

alter table public.portal_asset
  add column if not exists purge_after timestamptz;

create index if not exists portal_asset_purge_after_idx
  on public.portal_asset (purge_after)
  where purge_after is not null;

comment on column public.portal_asset.purge_after is
  'Object deletion target: quarantined assets 90 days after review; superseded archived versions 365 days after archival. Active and pending records have no purge date.';

create or replace function public.portal_review_asset(
  p_asset_id uuid,
  p_decision text,
  p_note text,
  p_reviewer_id uuid,
  p_reviewer_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.portal_asset%rowtype;
  changed public.portal_asset%rowtype;
begin
  if p_decision not in ('approve', 'quarantine') then
    raise exception 'Choose approve or quarantine';
  end if;

  select * into target
  from public.portal_asset
  where id = p_asset_id
  for update;

  if target.id is null then raise exception 'Asset not found'; end if;
  if target.state <> 'pending_review' then
    raise exception 'Only an uploaded asset awaiting review can be decided';
  end if;
  if target.created_by is not null and target.created_by = p_reviewer_id then
    raise exception 'A different authorized reviewer must decide this upload';
  end if;
  if p_decision = 'quarantine' and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'A quarantine reason is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(target.owner_type || ':' || target.owner_id::text || ':' || target.purpose, 0)
  );

  if p_decision = 'approve' then
    update public.portal_asset
    set state = 'archived',
        purge_after = now() + interval '365 days',
        updated_at = now()
    where owner_type = target.owner_type
      and owner_id = target.owner_id
      and purpose = target.purpose
      and state = 'active'
      and id <> target.id;
  end if;

  update public.portal_asset
  set state = case when p_decision = 'approve' then 'active' else 'quarantined' end,
      review_note = nullif(trim(coalesce(p_note, '')), ''),
      reviewed_by = p_reviewer_id,
      reviewed_by_email = p_reviewer_email,
      reviewed_at = now(),
      purge_after = case when p_decision = 'quarantine' then now() + interval '90 days' else null end,
      updated_at = now()
  where id = target.id
  returning * into changed;

  if p_decision = 'approve' and target.purpose = 'product_image' then
    update public.portal_product_content
    set image_asset_id = target.id, updated_at = now()
    where canix_item_id = target.owner_id;
    if not found then
      raise exception 'Create the Canix-linked product content row before approving its image';
    end if;
  elsif p_decision = 'approve' and target.purpose = 'coa_document' then
    update public.canix_package_coa
    set portal_asset_id = target.id
    where package_id = target.owner_id;
    if not found then
      raise exception 'The Canix package does not have a current normalized COA row';
    end if;
  end if;

  return to_jsonb(changed);
end;
$$;

revoke all on function public.portal_review_asset(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_review_asset(uuid, text, text, uuid, text)
  to service_role;

update public.portal_asset
set purge_after = case
  when state = 'quarantined' then coalesce(reviewed_at, updated_at, created_at) + interval '90 days'
  when state = 'archived' then coalesce(updated_at, reviewed_at, created_at) + interval '365 days'
  else null
end
where state in ('quarantined', 'archived')
  and purge_after is null;

