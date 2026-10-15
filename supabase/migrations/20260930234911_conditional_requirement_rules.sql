-- Conditional business requirements for Brand governance and agreements.
-- Uploaded files remain optional. When a file is supplied, the existing
-- private-storage and malware-scanning controls still apply.

alter table public.portal_brand_governance_policy
  add column if not exists relationship_template text not null default 'custom'
    check (relationship_template in (
      'custom', 'manufacturing_sales_distribution', 'distribution_only',
      'toll', 'consignment', 'revenue_share', 'company_owned'
    )),
  add column if not exists manufacturing_enabled boolean not null default false,
  add column if not exists sales_enabled boolean not null default false,
  add column if not exists distribution_enabled boolean not null default false,
  add column if not exists trademark_license_required boolean not null default false,
  add column if not exists msa_covers_confidentiality boolean not null default false,
  add column if not exists ownership_model text not null default 'not_set'
    check (ownership_model in ('not_set', 'ux', 'toll', 'split', 'test')),
  add column if not exists consignment_enabled boolean not null default false,
  add column if not exists revenue_share_enabled boolean not null default false,
  add column if not exists electronic_payments_enabled boolean not null default false,
  add column if not exists manufacturing_contact text,
  add column if not exists shipping_contact text,
  add column if not exists delivery_terms text,
  add column if not exists settlement_method text,
  add column if not exists brand_license_type text,
  add column if not exists brand_license_number text,
  add column if not exists brand_license_expires_on date,
  add column if not exists relationship_exception_reason text,
  add column if not exists relationship_exception_evidence text,
  add column if not exists relationship_exception_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists relationship_exception_approved_by_email text,
  add column if not exists relationship_exception_approved_at timestamptz;

alter table public.portal_brand_agreement_requirement
  add column if not exists decision_reason text,
  add column if not exists review_owner text,
  add column if not exists target_review_on date,
  add column if not exists evidence_summary text,
  add column if not exists decision_by uuid references auth.users(id) on delete set null,
  add column if not exists decision_by_email text,
  add column if not exists decision_at timestamptz;

update public.portal_brand_agreement_requirement
set decision_reason = coalesce(
      nullif(btrim(decision_reason), ''),
      'Existing decision carried forward for structured review.'
    ),
    decision_by_email = coalesce(
      nullif(btrim(decision_by_email), ''),
      'system@urbanxtracts.com'
    ),
    decision_at = coalesce(decision_at, now())
where applicability = 'not_required';

update public.portal_brand_agreement_requirement
set review_owner = coalesce(nullif(btrim(review_owner), ''), 'Operations'),
    target_review_on = coalesce(target_review_on, current_date + 30)
where applicability = 'pending_review';

alter table public.portal_brand_agreement_requirement
  add constraint portal_brand_requirement_decision_detail_check
  check (
    (applicability <> 'not_required') or (
      nullif(btrim(decision_reason), '') is not null
      and nullif(btrim(decision_by_email), '') is not null
      and decision_at is not null
    )
  ),
  add constraint portal_brand_requirement_pending_detail_check
  check (
    (applicability <> 'pending_review') or (
      nullif(btrim(review_owner), '') is not null
      and target_review_on is not null
    )
  );

alter table public.portal_brand_agreement
  add column if not exists term_type text not null default 'not_specified'
    check (term_type in ('not_specified', 'fixed_term', 'evergreen', 'indefinite')),
  add column if not exists renewal_review_on date,
  add column if not exists evidence_summary text;

update public.portal_brand_agreement
set term_type = case when expires_on is not null then 'fixed_term' else 'indefinite' end,
    effective_on = coalesce(effective_on, created_at::date),
    renewal_owner = coalesce(nullif(btrim(renewal_owner), ''), 'Operations'),
    evidence_summary = coalesce(
      nullif(btrim(evidence_summary), ''),
      case when document_reference is null
        then 'Legacy agreement record retained before evidence notes became required.'
        else 'Signed agreement retained in the protected portal document store.'
      end
    ),
    updated_at = now()
where term_type = 'not_specified';

alter table public.portal_brand_agreement
  add constraint portal_brand_agreement_term_detail_check
  check (
    visibility <> 'published'
    or term_type = 'not_specified'
    or (term_type = 'fixed_term' and effective_on is not null and expires_on is not null
        and nullif(btrim(renewal_owner), '') is not null)
    or (term_type = 'evergreen' and effective_on is not null and expires_on is null
        and renewal_review_on is not null and nullif(btrim(renewal_owner), '') is not null)
    or (term_type = 'indefinite' and effective_on is not null and expires_on is null)
  );

update public.portal_brand_governance_policy as policy
set relationship_template = case
      when detail.classification = 'company_owned' then 'company_owned'
      else policy.relationship_template
    end,
    ownership_model = case
      when detail.classification = 'company_owned' then 'ux'
      else policy.ownership_model
    end,
    updated_at = now()
from public.portal_brand_profile_detail as detail
where detail.organization_id = policy.organization_id;

create or replace function public.portal_publish_brand_agreement(
  p_agreement_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_review_note text default null
)
returns public.portal_brand_agreement
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.portal_brand_agreement%rowtype;
  previous public.portal_brand_agreement%rowtype;
  published_status text;
  reminder integer;
  renewal_anchor date;
begin
  select * into target
  from public.portal_brand_agreement
  where id = p_agreement_id
  for update;

  if not found then raise exception 'Agreement not found'; end if;
  if target.status <> 'in_review' or target.visibility <> 'internal' then
    raise exception 'Only an agreement awaiting review can be published';
  end if;

  -- A document is optional. If one exists, it can only have reached this table
  -- after the server received a digest-bound clean scanner verdict.
  if exists (
    select 1 from public.portal_brand_agreement_document
    where agreement_id = target.id and scan_state <> 'clean'
  ) then
    raise exception 'An attached agreement document has not passed scanning';
  end if;

  if target.term_type = 'fixed_term' and (
    target.effective_on is null or target.expires_on is null
    or nullif(btrim(target.renewal_owner), '') is null
  ) then raise exception 'Fixed-term agreements require effective date, expiration date, and renewal owner';
  end if;
  if target.term_type = 'evergreen' and (
    target.effective_on is null or target.expires_on is not null
    or target.renewal_review_on is null
    or nullif(btrim(target.renewal_owner), '') is null
  ) then raise exception 'Evergreen agreements require effective date, review date, and renewal owner, with no expiration date';
  end if;
  if target.term_type = 'indefinite' and (
    target.effective_on is null or target.expires_on is not null
  ) then raise exception 'Indefinite agreements require an effective date and no expiration date';
  end if;
  if target.term_type = 'not_specified' then
    raise exception 'Choose whether the agreement is fixed-term, evergreen, or indefinite';
  end if;

  published_status := case
    when target.expires_on is not null and target.expires_on < current_date then 'expired'
    when target.expires_on is not null and target.expires_on <= current_date + 90 then 'expiring'
    else 'active'
  end;

  if published_status in ('active', 'expiring') then
    select * into previous
    from public.portal_brand_agreement
    where organization_id = target.organization_id
      and requirement_code = target.requirement_code
      and id <> target.id and visibility = 'published'
      and status in ('active', 'expiring')
    order by published_at desc nulls last, updated_at desc
    limit 1 for update;
    if found then
      update public.portal_brand_agreement
      set status = 'superseded', visibility = 'archived', archived_at = now(),
          archived_by = p_actor_id, updated_at = now()
      where id = previous.id;
      target.supersedes_agreement_id := previous.id;
    end if;
  end if;

  update public.portal_brand_agreement
  set status = published_status, visibility = 'published', review_decision = 'approved',
      review_note = nullif(btrim(p_review_note), ''), brand_response_note = null,
      reviewed_by = p_actor_id, reviewed_by_email = nullif(btrim(p_actor_email), ''),
      reviewed_at = now(), published_by = p_actor_id, published_at = now(),
      archived_at = null, archived_by = null,
      supersedes_agreement_id = target.supersedes_agreement_id, updated_at = now()
  where id = target.id returning * into target;

  delete from public.portal_brand_agreement_renewal_notice where agreement_id = target.id;
  renewal_anchor := coalesce(target.expires_on, target.renewal_review_on);
  if renewal_anchor is not null and published_status in ('active', 'expiring') then
    foreach reminder in array target.renewal_notice_days loop
      insert into public.portal_brand_agreement_renewal_notice (
        organization_id, agreement_id, reminder_days, remind_on, status, created_at, updated_at
      ) values (
        target.organization_id, target.id, reminder, renewal_anchor - reminder,
        'pending', now(), now()
      );
    end loop;
  end if;
  return target;
end;
$$;

revoke all on function public.portal_publish_brand_agreement(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.portal_publish_brand_agreement(uuid, uuid, text, text)
  to service_role;

comment on column public.portal_brand_governance_policy.relationship_template is
  'Reusable relationship pattern that seeds activity flags; each saved flag remains explicit and audited.';
comment on column public.portal_brand_agreement.evidence_summary is
  'Required business evidence note when no agreement PDF is supplied. Files are optional but scanned when present.';
