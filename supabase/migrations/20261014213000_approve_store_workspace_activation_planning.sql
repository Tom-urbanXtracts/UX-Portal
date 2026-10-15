-- Record the owner's Store Workspace decision without claiming release or
-- enabling a capability. Applied historical migrations remain unchanged.

update public.portal_readiness_task
set status = 'in_progress',
    description = 'Plan the first Store Workspace release from the approved activation handoff: scoped dashboard, catalog and source-labelled availability, orders, retailer organizations and licensed locations, documents/licenses, approved read-only QuickBooks financial visibility, shared interactions, strict tenancy, pilot, rollout, and rollback.',
    owner_label = 'Sales / Operations / Product / IT',
    evidence_summary = 'Owner approved Store Workspace activation planning on 14 October 2026. This is planning approval only: the expanded workspace is not live and production activation still requires reconciled Store Workspace, Store Roles, and OS Portal Arch inputs; Release Readiness evidence; acceptance; controlled pilot; rollback rehearsal; and a separate release decision. Canix remains authoritative for cannabis inventory/compliance; QuickBooks remains authoritative and read-only for accounting; no new active Monday dependency is approved.',
    source_reference = 'docs/store-workspace-first-release-activation-handoff.md; docs/store-workspace-activation-architecture.md; docs/ux-os-capability-claims-audit.md',
    completion_check = 'store_workspace_first_release_activation',
    active = true,
    updated_at = now()
where task_key = 'retailer-buying-desk';

insert into public.portal_readiness_evidence (task_id, label, note)
select task.id,
       'Store activation planning decision',
       'Approved for activation planning by the owner on 14 October 2026. This does not authorize production activation or a live claim. The build and release gates are in docs/store-workspace-first-release-activation-handoff.md.'
from public.portal_readiness_task as task
where task.task_key = 'retailer-buying-desk'
  and not exists (
    select 1
    from public.portal_readiness_evidence as evidence
    where evidence.task_id = task.id
      and evidence.label = 'Store activation planning decision'
  );
