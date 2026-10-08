import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const EXTERNAL_ROLES = new Set(["owner", "buyer", "budtender"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BRAND_ROLES = new Set([
  "brand_owner",
  "brand_manager",
  "brand_contributor",
  "brand_viewer",
]);

type Row = Record<string, unknown>;

class AdminError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function origin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
      "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
      "https://portal.urbanxtracts.com",
      "https://tom-urbanxtracts.github.io",
      "http://127.0.0.1:4173",
      "http://localhost:4173",
    ]).has(candidate)
    ? candidate
    : "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site";
}

function headers(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": origin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function text(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function actorFor(request: Request): Promise<Row | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  if (!verifiedTokenIsAuthenticated(authorization)) return null;
  const user = await response.json();
  const { data: profile } = await service.from("portal_profile").select(
    "id,role,staff_role,active,org,locations",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false) return null;
  if (
    profile.role !== "internal" && profile.role !== "owner" &&
    profile.role !== "brand"
  ) return null;
  return profile as Row;
}

async function hasPermission(actor: Row, permission: string): Promise<boolean> {
  if (actor.role !== "internal") return false;
  const { data } = await service.from("portal_role_permission").select(
    "permission",
  )
    .eq("staff_role", actor.staff_role).eq("permission", permission)
    .maybeSingle();
  return !!data;
}

async function brandAccess(
  actor: Row,
  organizationId: string,
  permission: "brand.users.read" | "brand.users.manage",
): Promise<Row> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new AdminError(400, "Choose a valid Brand organization.");
  }
  const { data: organization, error: organizationError } = await service
    .from("portal_organization").select("id,display_name,legal_name,status,kind")
    .eq("id", organizationId).eq("kind", "brand").eq("status", "active")
    .maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new AdminError(404, "Active Brand organization not found.");

  if (
    actor.role === "internal" && actor.staff_role === "administrator" &&
    await hasPermission(actor, "users.manage")
  ) {
    return {
      organization,
      memberRole: "workforce_administrator",
      membershipId: null,
      internalAdministrator: true,
    };
  }

  const { data: membership, error: membershipError } = await service
    .from("portal_organization_membership")
    .select("id,member_role,status,organization_id")
    .eq("profile_id", actor.id).eq("organization_id", organizationId)
    .eq("workspace", "brand").eq("status", "active").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new AdminError(403, "This Brand is outside your access scope.");

  const { data: allowed, error: permissionError } = await service
    .from("portal_workspace_role_permission").select("permission")
    .eq("workspace", "brand").eq("member_role", membership.member_role)
    .eq("permission", permission).maybeSingle();
  if (permissionError) throw permissionError;
  if (!allowed) throw new AdminError(403, "Your Brand role cannot manage this access.");
  return {
    organization,
    memberRole: membership.member_role,
    membershipId: membership.id,
    internalAdministrator: false,
  };
}

async function findAuthUser(email: string): Promise<Row | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    const match = data.users.find((user) =>
      String(user.email ?? "").toLowerCase() === email
    );
    if (match) return match as unknown as Row;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function listAuthUsers(): Promise<Row[]> {
  const users: Row[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    users.push(...(data.users as unknown as Row[]));
    if (data.users.length < 1000) break;
    if (page === 20) {
      throw new AdminError(
        503,
        "The user directory is too large to review safely.",
      );
    }
  }
  return users;
}

function testDemoReason(user: Row, profile: Row): string | null {
  const email = text(user.email, 320).toLowerCase();
  const org = text(profile.org, 200).toLowerCase();
  const appMetadata = user.app_metadata && typeof user.app_metadata === "object"
    ? user.app_metadata as Row
    : {};
  if (appMetadata.portal_test_account === true) {
    return "Portal role-acceptance test identity";
  }
  if (
    new Set([
      "dana@downtownprovisions.com",
      "marcus@downtownprovisions.com",
      "priya@downtownprovisions.com",
      "sam@riversidecollective.com",
      "toni@urbanxtracts.com",
    ]).has(email)
  ) {
    return "Legacy prototype fixture identity";
  }
  if (email.endsWith("@executive-demo.invalid")) {
    return "Executive-demo identity";
  }
  if (
    /^(uxos-e2e|ux-os-e2e|portal-e2e|test|demo)[+._-][a-z0-9+._-]+@(example\.com|example\.org|example\.net)$/i
      .test(email)
  ) {
    return "Reserved-domain test identity";
  }
  if (
    new Set(["cannabis store (demo)", "executive demo retail group"])
      .has(org)
  ) {
    return "Executive-demo organization";
  }
  return null;
}

async function portalUsers(actor: Row): Promise<Row[]> {
  if (actor.role !== "internal" && actor.role !== "owner") {
    throw new AdminError(403, "This user directory is outside your access scope.");
  }
  if (
    actor.role === "internal" &&
    !(await hasPermission(actor, "users.manage"))
  ) {
    throw new AdminError(403, "Only an Administrator may list portal users.");
  }
  const [authUsers, profileResult] = await Promise.all([
    listAuthUsers(),
    service.from("portal_profile").select(
      "id,full_name,org,role,locations,active,staff_role",
    ).order("full_name", { ascending: true }),
  ]);
  if (profileResult.error) throw profileResult.error;
  const authById = new Map(
    authUsers.map((user) => [String(user.id), user]),
  );
  return ((profileResult.data ?? []) as Row[]).filter((profile) =>
    actor.role === "internal" ||
    (profile.org === actor.org && EXTERNAL_ROLES.has(String(profile.role)))
  ).map((profile) => {
    const user = authById.get(String(profile.id)) ?? {};
    const email = text(user.email, 320).toLowerCase();
    const reason = testDemoReason(user, profile);
    const appMetadata = user.app_metadata && typeof user.app_metadata === "object"
      ? user.app_metadata as Row
      : {};
    const accessExpiresOn = text(appMetadata.portal_access_expires_on, 10);
    const accountType = text(appMetadata.portal_account_type, 40) === "contractor"
      ? "contractor"
      : "standard";
    return {
      id: profile.id,
      email,
      fullName: text(profile.full_name, 160) || email || "Unnamed user",
      org: profile.org,
      role: profile.role,
      staffRole: profile.staff_role,
      locations: profile.locations,
      active: profile.active !== false && !user.deleted_at,
      accountType,
      accessExpiresOn,
      accessExpired: accountType === "contractor" && ISO_DATE.test(accessExpiresOn) &&
        accessExpiresOn < todayIso(),
      testDemo: !!reason,
      testDemoReason: reason,
    };
  }).filter((user) => user.email);
}

async function accessReviews(actor: Row): Promise<Row[]> {
  if (actor.role !== "internal" || !(await hasPermission(actor, "users.manage"))) return [];
  const { data, error } = await service.from("portal_access_review").select(
    "id,profile_id,store_license,review_type,state,reason,created_at",
  ).eq("state", "pending").order("created_at", { ascending: true }).limit(500);
  if (error) throw error;
  const profileIds = Array.from(new Set((data ?? []).map((row) => row.profile_id)));
  const licenses = Array.from(new Set((data ?? []).map((row) => row.store_license)));
  const [profileResult, storeResult] = await Promise.all([
    profileIds.length
      ? service.from("portal_profile").select("id,full_name,org,role").in("id", profileIds)
      : Promise.resolve({ data: [], error: null }),
    licenses.length
      ? service.from("portal_store").select("license_number,display_name,organization").in("license_number", licenses)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (profileResult.error) throw profileResult.error;
  if (storeResult.error) throw storeResult.error;
  const profiles = new Map<string, Row>(
    ((profileResult.data ?? []) as Row[]).map((row) => [String(row.id), row]),
  );
  const stores = new Map<string, Row>(
    ((storeResult.data ?? []) as Row[]).map((row) => [
      String(row.license_number),
      row,
    ]),
  );
  return (data ?? []).map((row) => {
    const profile = profiles.get(String(row.profile_id)) ?? {};
    const store = stores.get(String(row.store_license)) ?? {};
    return {
      id: row.id,
      profileId: row.profile_id,
      profileName: profile.full_name,
      organization: profile.org ?? store.organization,
      role: profile.role,
      storeLicense: row.store_license,
      storeName: store.display_name,
      reviewType: row.review_type,
      reason: row.reason,
      createdAt: row.created_at,
    };
  });
}

async function resolveAccessReview(request: Request, actor: Row, body: Row): Promise<Response> {
  if (actor.role !== "internal" || !(await hasPermission(actor, "users.manage"))) {
    throw new AdminError(403, "Only an Administrator may resolve access reviews.");
  }
  const reviewId = text(body.reviewId, 80);
  const decision = text(body.decision, 20).toLowerCase();
  if (!new Set(["assign", "dismiss"]).has(decision)) {
    throw new AdminError(400, "Choose Assign or Dismiss.");
  }
  const { data: review, error } = await service.from("portal_access_review").select("*")
    .eq("id", reviewId).eq("state", "pending").maybeSingle();
  if (error) throw error;
  if (!review) throw new AdminError(404, "Pending access review not found.");
  if (decision === "assign") {
    const { error: assignmentError } = await service.from("portal_profile_store").insert({
      profile_id: review.profile_id,
      license_number: review.store_license,
    });
    if (assignmentError && assignmentError.code !== "23505") throw assignmentError;
  }
  const { error: updateError } = await service.from("portal_access_review").update({
    state: decision === "assign" ? "assigned" : "dismissed",
    resolved_by: actor.id,
    resolved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", review.id).eq("state", "pending");
  if (updateError) throw updateError;
  await audit(actor, `access-review-${decision}`, { id: review.profile_id }, {
    org: null,
    accessReviewId: review.id,
    storeLicense: review.store_license,
  });
  return json(request, { ok: true, reviews: await accessReviews(actor) });
}

async function removeTestDemoUser(
  request: Request,
  actor: Row,
  email: string,
): Promise<Response> {
  if (
    actor.role !== "internal" ||
    !(await hasPermission(actor, "users.manage"))
  ) {
    return json(request, {
      error: "Only an Administrator may remove test or demo users.",
    }, 403);
  }
  const target = await findAuthUser(email);
  if (!target) return json(request, { error: "User not found" }, 404);
  if (String(target.id) === String(actor.id)) {
    return json(request, { error: "You cannot remove your own account." }, 409);
  }
  const { data: profile, error: profileError } = await service.from(
    "portal_profile",
  ).select("id,full_name,org,role,locations,active,staff_role").eq(
    "id",
    target.id,
  ).maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    return json(request, { error: "Portal profile not found" }, 404);
  }
  const reason = testDemoReason(target, profile as Row);
  if (!reason) {
    return json(request, {
      error:
        "This account is not marked as a test or executive-demo identity. Deactivate it instead.",
    }, 409);
  }
  await audit(actor, "remove-test-user", { ...target, email }, {
    org: profile.org,
    role: profile.role,
    locations: profile.locations,
    reason,
    deletionMode: "soft",
  });
  const { error: authError } = await service.auth.admin.deleteUser(
    String(target.id),
    true,
  );
  if (authError) throw authError;
  const { error: deleteProfileError } = await service.from("portal_profile")
    .delete().eq("id", target.id);
  if (deleteProfileError) {
    await service.from("portal_profile").update({ active: false }).eq(
      "id",
      target.id,
    );
    throw deleteProfileError;
  }
  return json(request, {
    ok: true,
    removed: { email, fullName: profile.full_name, org: profile.org, reason },
  });
}

function ensureScope(actor: Row, targetOrg: string, role: string): void {
  if (!EXTERNAL_ROLES.has(role)) {
    throw new AdminError(
      400,
      "Only retailer owner, buyer, and budtender roles can be managed here.",
    );
  }
  if (
    actor.role !== "internal" && (targetOrg !== actor.org || role === "owner")
  ) {
    throw new AdminError(
      403,
      "Store owners can manage buyers and budtenders only inside their own organisation.",
    );
  }
}

async function audit(
  actor: Row,
  action: string,
  target: Row,
  detail: Row,
): Promise<void> {
  const { error } = await service.from("portal_admin_audit").insert({
    actor_id: actor.id,
    actor_org: actor.org,
    action,
    target_id: target.id ?? null,
    target_email: target.email ?? null,
    target_org: detail.org ?? null,
    detail,
  });
  if (error) throw error;
}

async function brandWorkspaces(actor: Row): Promise<Row[]> {
  if (
    actor.role !== "internal" || actor.staff_role !== "administrator" ||
    !(await hasPermission(actor, "users.manage"))
  ) {
    throw new AdminError(403, "Only a workforce Administrator may view as a Brand.");
  }
  const { data: organizations, error } = await service.from("portal_organization")
    .select("id,display_name,legal_name,status").eq("kind", "brand")
    .eq("status", "active").order("display_name", { ascending: true }).limit(500);
  if (error) throw error;
  const ids = (organizations ?? []).map((organization) => organization.id);
  const accountResult = ids.length
    ? await service.from("portal_brand_account")
      .select("organization_id,scope_status,canix_brand_id,canix_owner_id,monday_account_item_id")
      .in("organization_id", ids)
    : { data: [], error: null };
  if (accountResult.error) throw accountResult.error;
  const accountByOrganization = new Map(
    ((accountResult.data ?? []) as Row[]).map((account) => [String(account.organization_id), account]),
  );
  return ((organizations ?? []) as Row[]).map((organization) => {
    const account = accountByOrganization.get(String(organization.id)) ?? {};
    return {
      id: organization.id,
      name: organization.display_name,
      legalName: organization.legal_name,
      scopeStatus: account.scope_status ?? "pending",
      canixMapped: !!(account.canix_brand_id || account.canix_owner_id),
      mondayMapped: !!account.monday_account_item_id,
    };
  });
}

async function brandView(
  request: Request,
  actor: Row,
  body: Row,
  action: "start-brand-view" | "end-brand-view",
): Promise<Response> {
  const brands = await brandWorkspaces(actor);
  const organizationId = text(body.organizationId, 80);
  const brand = brands.find((candidate) => String(candidate.id) === organizationId);
  if (!brand) throw new AdminError(404, "Active Brand workspace not found.");
  await audit(actor, action, { id: brand.id }, {
    org: brand.name,
    organizationId: brand.id,
    mode: "read_only",
    sourceScopeStatus: brand.scopeStatus,
  });
  return json(request, { ok: true, brand, readOnly: true });
}

function brandRoleLabel(role: unknown): string {
  return ({
    brand_owner: "Brand Owner",
    brand_manager: "Brand Manager",
    brand_contributor: "Brand Contributor",
    brand_viewer: "Brand Viewer",
  } as Record<string, string>)[String(role)] ?? "Brand member";
}

function brandRoleMayAssign(actorRole: unknown, targetRole: string): boolean {
  if (actorRole === "workforce_administrator") return BRAND_ROLES.has(targetRole);
  if (actorRole === "brand_owner") {
    return new Set(["brand_manager", "brand_contributor", "brand_viewer"])
      .has(targetRole);
  }
  if (actorRole === "brand_manager") {
    return new Set(["brand_contributor", "brand_viewer"]).has(targetRole);
  }
  return false;
}

async function brandUsers(actor: Row, body: Row): Promise<Row> {
  const organizationId = text(body.organizationId, 80);
  const access = await brandAccess(actor, organizationId, "brand.users.read");
  const { data: memberships, error: membershipError } = await service
    .from("portal_organization_membership")
    .select("id,profile_id,member_role,status,is_default,created_at,updated_at")
    .eq("organization_id", organizationId).eq("workspace", "brand")
    .order("created_at", { ascending: true }).limit(500);
  if (membershipError) throw membershipError;
  const profileIds = (memberships ?? []).map((row) => row.profile_id);
  const [authUsers, profileResult] = await Promise.all([
    listAuthUsers(),
    profileIds.length
      ? service.from("portal_profile")
        .select("id,full_name,role,active,org,staff_role").in("id", profileIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (profileResult.error) throw profileResult.error;
  const authById = new Map(authUsers.map((user) => [String(user.id), user]));
  const profileById = new Map(
    ((profileResult.data ?? []) as Row[]).map((profile) => [String(profile.id), profile]),
  );
  const users = ((memberships ?? []) as Row[]).map((membership) => {
    const profile = profileById.get(String(membership.profile_id)) ?? {};
    const user = authById.get(String(membership.profile_id)) ?? {};
    const email = text(user.email, 320).toLowerCase();
    const active = membership.status === "active" && profile.active !== false &&
      !user.deleted_at;
    return {
      membershipId: membership.id,
      profileId: membership.profile_id,
      email,
      fullName: text(profile.full_name, 160) || email || "Unnamed user",
      profileRole: profile.role,
      memberRole: membership.member_role,
      roleLabel: brandRoleLabel(membership.member_role),
      status: active
        ? (user.last_sign_in_at ? "active" : "invited")
        : "disabled",
      active,
      isSelf: String(actor.id) === String(membership.profile_id),
      canEdit: String(actor.id) !== String(membership.profile_id) &&
        brandRoleMayAssign(access.memberRole, String(membership.member_role)),
    };
  }).filter((user) => user.email);
  return {
    organization: access.organization,
    actorRole: access.memberRole,
    canManage: access.internalAdministrator === true ||
      new Set(["brand_owner", "brand_manager"]).has(String(access.memberRole)),
    assignableRoles: Array.from(BRAND_ROLES).filter((role) =>
      brandRoleMayAssign(access.memberRole, role)
    ),
    users,
  };
}

async function inviteBrandUser(
  request: Request,
  actor: Row,
  body: Row,
): Promise<Response> {
  const organizationId = text(body.organizationId, 80);
  const access = await brandAccess(actor, organizationId, "brand.users.manage");
  const email = text(body.email, 320).toLowerCase();
  const fullName = text(body.fullName, 160);
  const memberRole = text(body.memberRole, 40);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !fullName) {
    throw new AdminError(400, "A name and valid email address are required.");
  }
  if (!BRAND_ROLES.has(memberRole) || !brandRoleMayAssign(access.memberRole, memberRole)) {
    throw new AdminError(403, "Your role cannot assign that level of Brand access.");
  }

  let target = await findAuthUser(email);
  const invited = !target;
  if (!target) {
    const { data, error } = await service.auth.admin.inviteUserByEmail(
      email,
      { data: { full_name: fullName } },
    );
    if (error || !data.user) {
      throw error ?? new Error("The Brand invitation did not create a user.");
    }
    target = data.user as unknown as Row;
  }

  const { data: currentProfile, error: profileReadError } = await service
    .from("portal_profile").select("id,role,active,org,full_name,staff_role")
    .eq("id", target.id).maybeSingle();
  if (profileReadError) throw profileReadError;
  if (
    currentProfile && !new Set(["brand", "internal"]).has(String(currentProfile.role))
  ) {
    throw new AdminError(
      409,
      "That email already belongs to a Store account. Use a separate Brand identity or ask an Administrator to review it.",
    );
  }
  const organization = access.organization as Row;
  if (!currentProfile) {
    const { error: profileError } = await service.from("portal_profile").insert({
      id: target.id,
      full_name: fullName,
      org: organization.display_name,
      role: "brand",
      locations: null,
      active: true,
      staff_role: null,
    });
    if (profileError) throw profileError;
  } else if (currentProfile.role === "brand") {
    const { error: profileError } = await service.from("portal_profile").update({
      full_name: fullName,
      active: true,
    }).eq("id", target.id);
    if (profileError) throw profileError;
  }

  const { error: membershipError } = await service
    .from("portal_organization_membership").upsert({
      profile_id: target.id,
      organization_id: organizationId,
      workspace: "brand",
      member_role: memberRole,
      status: "active",
      is_default: currentProfile?.role === "brand",
      updated_at: new Date().toISOString(),
    }, { onConflict: "profile_id,organization_id,workspace" });
  if (membershipError) throw membershipError;
  await service.auth.admin.updateUserById(String(target.id), {
    ban_duration: "none",
  });
  await audit(actor, "invite-brand-user", { ...target, email }, {
    org: organization.display_name,
    organizationId,
    memberRole,
    invited,
  });
  return json(request, {
    ok: true,
    invited,
    user: { id: target.id, email, fullName, memberRole, active: true },
  });
}

async function createTestBrandDemoUser(
  request: Request,
  actor: Row,
  body: Row,
): Promise<Response> {
  if (
    actor.role !== "internal" || actor.staff_role !== "administrator" ||
    !(await hasPermission(actor, "users.manage"))
  ) {
    throw new AdminError(403, "Only a workforce Administrator may create the Test Brand account.");
  }
  const email = text(body.email, 320).toLowerCase();
  const password = "UXDemo43!";
  if (email !== "marketing@urbanxtract.com") {
    throw new AdminError(400, "The isolated demo identity must be marketing@urbanxtract.com.");
  }
  const { data: organization, error: organizationError } = await service
    .from("portal_organization").select("id,display_name")
    .eq("kind", "brand").eq("legal_name", "Test Brand").maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new AdminError(409, "The Test Brand workspace has not been provisioned.");

  let target = await findAuthUser(email);
  if (!target) {
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Test Brand Marketing" },
      app_metadata: { portal_demo: true },
    });
    if (error || !data.user) throw error ?? new Error("The demo user was not created.");
    target = data.user as unknown as Row;
  } else {
    const { data, error } = await service.auth.admin.updateUserById(String(target.id), {
      password,
      email_confirm: true,
      ban_duration: "none",
      user_metadata: { full_name: "Test Brand Marketing" },
      app_metadata: { ...(target.app_metadata as Row ?? {}), portal_demo: true },
    });
    if (error || !data.user) throw error ?? new Error("The demo user was not updated.");
    target = data.user as unknown as Row;
  }

  const { error: profileError } = await service.from("portal_profile").upsert({
    id: target.id,
    full_name: "Test Brand Marketing",
    org: organization.display_name,
    role: "brand",
    locations: null,
    active: true,
    staff_role: null,
  }, { onConflict: "id" });
  if (profileError) throw profileError;
  const { error: membershipError } = await service
    .from("portal_organization_membership").upsert({
      profile_id: target.id,
      organization_id: organization.id,
      workspace: "brand",
      member_role: "brand_owner",
      status: "active",
      is_default: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "profile_id,organization_id,workspace" });
  if (membershipError) throw membershipError;
  await audit(actor, "create-test-brand-demo-user", { ...target, email }, {
    organizationId: organization.id,
    memberRole: "brand_owner",
    isolatedDemo: true,
  });
  return json(request, {
    ok: true,
    user: { id: target.id, email, fullName: "Test Brand Marketing", memberRole: "brand_owner" },
  });
}

async function updateBrandUser(
  request: Request,
  actor: Row,
  body: Row,
): Promise<Response> {
  const organizationId = text(body.organizationId, 80);
  const membershipId = text(body.membershipId, 80);
  const memberRole = text(body.memberRole, 40);
  const active = body.active !== false;
  const access = await brandAccess(actor, organizationId, "brand.users.manage");
  if (!BRAND_ROLES.has(memberRole) || !brandRoleMayAssign(access.memberRole, memberRole)) {
    throw new AdminError(403, "Your role cannot assign that level of Brand access.");
  }
  const { data: membership, error } = await service
    .from("portal_organization_membership")
    .select("id,profile_id,member_role,status")
    .eq("id", membershipId).eq("organization_id", organizationId)
    .eq("workspace", "brand").maybeSingle();
  if (error) throw error;
  if (!membership) throw new AdminError(404, "Brand membership not found.");
  if (String(membership.profile_id) === String(actor.id)) {
    throw new AdminError(409, "You cannot change or deactivate your own Brand access.");
  }
  if (!brandRoleMayAssign(access.memberRole, String(membership.member_role))) {
    throw new AdminError(403, "Your role cannot modify that Brand member.");
  }
  const membershipUpdate: Row = {
    member_role: memberRole,
    status: active ? "active" : "disabled",
    updated_at: new Date().toISOString(),
  };
  if (!active) membershipUpdate.is_default = false;
  const { error: updateError } = await service
    .from("portal_organization_membership").update(membershipUpdate)
    .eq("id", membership.id).eq("organization_id", organizationId);
  if (updateError) throw updateError;

  const { data: profile, error: profileError } = await service
    .from("portal_profile").select("id,role,org,active")
    .eq("id", membership.profile_id).maybeSingle();
  if (profileError) throw profileError;
  if (profile?.role === "brand") {
    const { count, error: countError } = await service
      .from("portal_organization_membership").select("id", {
        count: "exact",
        head: true,
      }).eq("profile_id", membership.profile_id).eq("status", "active");
    if (countError) throw countError;
    const hasActiveMembership = Number(count ?? 0) > 0;
    const { error: profileUpdateError } = await service.from("portal_profile")
      .update({ active: hasActiveMembership }).eq("id", membership.profile_id);
    if (profileUpdateError) throw profileUpdateError;
    const { error: authError } = await service.auth.admin.updateUserById(
      String(membership.profile_id),
      { ban_duration: hasActiveMembership ? "none" : "876000h" },
    );
    if (authError) throw authError;
  }
  await audit(actor, active ? "update-brand-user" : "deactivate-brand-user", {
    id: membership.profile_id,
  }, {
    org: (access.organization as Row).display_name,
    organizationId,
    membershipId,
    previousRole: membership.member_role,
    memberRole,
    active,
  });
  return json(request, { ok: true });
}

async function storesForAssignment(
  org: string,
  role: string,
  locations: string,
): Promise<Row[]> {
  if (role === "owner") return [];
  const { data: stores, error: storeError } = await service.from("portal_store")
    .select("license_number,display_name").eq("organization", org).eq(
      "active",
      true,
    ).eq("license_status", "active");
  if (storeError) throw storeError;
  const normalized = locations.toLowerCase();
  const allStores = /\ball\b.*\blocation/.test(normalized);
  const assigned = (stores ?? []).filter((store) =>
    allStores ||
    normalized.split(/[,;\n]/).map((part) => part.trim()).includes(
      String(store.display_name).toLowerCase(),
    ) ||
    normalized.includes(String(store.license_number).toLowerCase())
  );
  if (role === "budtender" && assigned.length !== 1) {
    throw new AdminError(
      400,
      "A Budtender must be assigned to exactly one store.",
    );
  }
  if (role === "buyer" && !assigned.length) {
    throw new AdminError(
      400,
      "A Buyer must be assigned to at least one store.",
    );
  }
  return assigned as unknown as Row[];
}

async function syncStoreAssignments(
  profileId: string,
  assigned: Row[],
): Promise<void> {
  const { error: deleteError } = await service.from("portal_profile_store")
    .delete().eq("profile_id", profileId);
  if (deleteError && deleteError.code !== "42P01") throw deleteError;
  if (!assigned.length) return;
  const { error: insertError } = await service.from("portal_profile_store")
    .insert(
      assigned.map((store) => ({
        profile_id: profileId,
        license_number: store.license_number,
      })),
    );
  if (insertError) throw insertError;
}

async function inviteOnboardingPerson(
  request: Request,
  actor: Row,
  body: Row,
): Promise<Response> {
  if (
    actor.role !== "internal" ||
    !(await hasPermission(actor, "accounts.manage"))
  ) {
    throw new AdminError(
      403,
      "Inviting onboarding users requires Administrator, Operations, or Sales access.",
    );
  }
  const personId = String(body.personId || "").trim();
  const requestId = String(body.requestId || "").trim();
  const { data: onboarding, error: requestError } = await service.from(
    "portal_onboarding_request",
  )
    .select("id,stage,retailer_account_id").eq("id", requestId).maybeSingle();
  if (requestError) throw requestError;
  if (!onboarding) throw new AdminError(404, "Onboarding request not found.");
  if (onboarding.stage !== "access") {
    throw new AdminError(
      409,
      "User invitations are available during the Access stage.",
    );
  }
  if (!onboarding.retailer_account_id) {
    throw new AdminError(
      409,
      "Link a retailer account before inviting onboarding users.",
    );
  }

  const { data: person, error: personError } = await service.from(
    "portal_onboarding_person",
  )
    .select("id,person_role,full_name,email,phone,store_license,access_status")
    .eq("id", personId).eq("onboarding_request_id", requestId).maybeSingle();
  if (personError) throw personError;
  if (!person) throw new AdminError(404, "Onboarding person not found.");
  if (person.access_status === "invited" || person.access_status === "active") {
    return json(request, {
      ok: true,
      idempotent: true,
      personId: person.id,
      accessStatus: person.access_status,
    });
  }

  const { data: account, error: accountError } = await service.from(
    "portal_retailer_account",
  )
    .select("id,organization_name").eq("id", onboarding.retailer_account_id)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account) throw new AdminError(404, "Linked retailer account not found.");
  const { data: onboardingStores, error: storeError } = await service.from(
    "portal_onboarding_store",
  )
    .select("license_number").eq("onboarding_request_id", requestId).eq(
      "qualification_status",
      "qualified",
    );
  if (storeError) throw storeError;
  const qualifiedLicenses = (onboardingStores ?? []).map((store) =>
    String(store.license_number)
  );
  if (!qualifiedLicenses.length) {
    throw new AdminError(
      409,
      "At least one qualified store is required before inviting users.",
    );
  }

  const role = String(person.person_role);
  let locations: string;
  if (role === "owner") locations = `All ${qualifiedLicenses.length} locations`;
  else if (role === "buyer" && person.store_license) {
    if (!qualifiedLicenses.includes(String(person.store_license))) {
      throw new AdminError(
        409,
        "The Buyer's selected store must have a qualified license before invitation.",
      );
    }
    locations = String(person.store_license);
  } else if (role === "buyer") locations = qualifiedLicenses.join(", ");
  else if (role === "budtender" && person.store_license) {
    if (!qualifiedLicenses.includes(String(person.store_license))) {
      throw new AdminError(
        409,
        "The Budtender's selected store must have a qualified license before invitation.",
      );
    }
    locations = String(person.store_license);
  } else {throw new AdminError(
      409,
      "A Budtender needs exactly one qualified store before invitation.",
    );}
  const assignedStores = await storesForAssignment(
    String(account.organization_name),
    role,
    locations,
  );

  const email = String(person.email || "").trim().toLowerCase();
  let target = await findAuthUser(email);
  if (target) {
    const { data: current, error: currentError } = await service.from(
      "portal_profile",
    )
      .select("id,org,role").eq("id", target.id).maybeSingle();
    if (currentError) throw currentError;
    if (current && current.org !== account.organization_name) {
      throw new AdminError(
        409,
        "That email already belongs to another retailer organization.",
      );
    }
    if (current) {
      throw new AdminError(
        409,
        "That email already has portal access. An Administrator must change an existing account.",
      );
    }
  } else {
    const { data, error } = await service.auth.admin.inviteUserByEmail(email, {
      data: { full_name: String(person.full_name || email) },
    });
    if (error || !data.user) {
      throw error ?? new Error("The invitation did not create a user.");
    }
    target = data.user as unknown as Row;
  }

  const profile = {
    id: target.id,
    full_name: String(person.full_name || email),
    org: account.organization_name,
    role,
    locations,
    active: true,
    staff_role: null,
  };
  const { error: profileError } = await service.from("portal_profile").upsert(
    profile,
    { onConflict: "id" },
  );
  if (profileError) throw profileError;
  await syncStoreAssignments(String(target.id), assignedStores);
  const { error: authError } = await service.auth.admin.updateUserById(
    String(target.id),
    { ban_duration: "none" },
  );
  if (authError) throw authError;
  const { error: onboardingError } = await service.from(
    "portal_onboarding_person",
  ).update({
    portal_profile_id: target.id,
    access_status: "invited",
    invited_by: actor.id,
    invited_at: new Date().toISOString(),
  }).eq("id", person.id);
  if (onboardingError) throw onboardingError;
  await audit(actor, "invite-onboarding-user", { ...target, email }, {
    org: account.organization_name,
    role,
    locations,
    onboardingRequestId: requestId,
    onboardingPersonId: person.id,
  });
  return json(request, {
    ok: true,
    personId: person.id,
    accessStatus: "invited",
    user: { id: target.id, email, role, locations },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const actor = await actorFor(request);
    if (!actor) return json(request, { error: "Forbidden" }, 403);
    const body = await request.json() as Row;
    const action = text(body.action, 40);
    if (action === "invite-onboarding-person") {
      return await inviteOnboardingPerson(request, actor, body);
    }
    if (action === "resolve-access-review") {
      return await resolveAccessReview(request, actor, body);
    }
    if (action === "list-brand-users") {
      return json(request, await brandUsers(actor, body));
    }
    if (action === "invite-brand-user") {
      return await inviteBrandUser(request, actor, body);
    }
    if (action === "create-test-brand-demo-user") {
      return await createTestBrandDemoUser(request, actor, body);
    }
    if (action === "update-brand-user") {
      return await updateBrandUser(request, actor, body);
    }
    const email = text(body.email, 320).toLowerCase();
    if (action === "list-users") {
      const [users, reviews, brands] = await Promise.all([
        portalUsers(actor),
        accessReviews(actor),
        actor.role === "internal" && actor.staff_role === "administrator"
          ? brandWorkspaces(actor)
          : Promise.resolve([]),
      ]);
      return json(request, { users, reviews, brands });
    }
    if (action === "start-brand-view" || action === "end-brand-view") {
      return await brandView(request, actor, body, action);
    }
    if (action === "remove-test-user") {
      if (!email || !email.includes("@")) {
        return json(request, { error: "A valid user email is required." }, 400);
      }
      return await removeTestDemoUser(request, actor, email);
    }
    if (action === "invite-workforce-administrator") {
      if (
        actor.role !== "internal" || actor.staff_role !== "administrator" ||
        !(await hasPermission(actor, "users.manage"))
      ) {
        return json(request, {
          error: "Only a workforce Administrator may add another Administrator.",
        }, 403);
      }
      if (!/^[^@\s]+@urbanxtracts\.com$/.test(email)) {
        return json(request, {
          error: "Use the employee's urbanxtracts.com email address.",
        }, 400);
      }
      if (body.confirmAdministrator !== true) {
        return json(request, {
          error: "Confirm the Administrator access grant before continuing.",
        }, 400);
      }
      const fullName = text(body.fullName, 160);
      if (!fullName) {
        return json(request, { error: "A name is required." }, 400);
      }
      let target = await findAuthUser(email);
      const invited = !target;
      if (!target) {
        const { data, error } = await service.auth.admin.inviteUserByEmail(
          email,
          { data: { full_name: fullName } },
        );
        if (error || !data.user) {
          throw error ?? new Error("The invitation did not create a user.");
        }
        target = data.user as unknown as Row;
      }
      const { error: grantError } = await service.rpc(
        "portal_grant_workforce_administrator",
        {
          p_actor_id: actor.id,
          p_target_id: target.id,
          p_full_name: fullName,
        },
      );
      if (grantError) {
        if (grantError.message.includes("already has Administrator access")) {
          return json(request, { error: grantError.message }, 409);
        }
        if (grantError.message.includes("existing retailer or deactivated account")) {
          return json(request, { error: grantError.message }, 409);
        }
        if (invited) {
          console.error("portal-admin workforce grant after invitation", grantError);
          return json(request, {
            error: "The invitation may have been sent, but Administrator access was not granted. Check the user list before retrying.",
          }, 503);
        }
        throw grantError;
      }
      return json(request, {
        ok: true,
        invited,
        user: {
          id: target.id,
          email,
          org: "urbanXtracts",
          role: "internal",
          staffRole: "administrator",
        },
      });
    }
    const org = text(body.org, 200);
    const roleLabel = text(body.role, 40);
    const role = ({
      "Store owner": "owner",
      "Buyer": "buyer",
      "Budtender": "budtender",
    } as Record<string, string>)[roleLabel] ?? roleLabel.toLowerCase();
    const locations = text(body.locations, 1000);
    const accountType = text(body.accountType, 40) === "contractor"
      ? "contractor"
      : "standard";
    const accessExpiresOn = text(body.accessExpiresOn, 10);
    if (!email || !email.includes("@") || !org) {
      return json(request, {
        error: "A valid email and organisation are required.",
      }, 400);
    }
    if (accountType === "contractor") {
      if (actor.role !== "internal" || !(await hasPermission(actor, "users.manage"))) {
        return json(request, {
          error: "Only IT/Admin may create contractor portal accounts.",
        }, 403);
      }
      if (!ISO_DATE.test(accessExpiresOn) || accessExpiresOn <= todayIso()) {
        return json(request, {
          error: "Contractor accounts require a future expiration date.",
        }, 400);
      }
    }
    ensureScope(actor, org, role);
    let target = await findAuthUser(email);
    let current: Row | null = null;
    if (target) {
      const { data, error: currentError } = await service.from("portal_profile")
        .select("id,org,role,active,locations").eq("id", target.id)
        .maybeSingle();
      if (currentError) throw currentError;
      current = data as Row | null;
      if (current && actor.role !== "internal" && current.org !== actor.org) {
        return json(request, { error: "Forbidden" }, 403);
      }
    }

    if (action === "invite-user") {
      if (
        actor.role === "internal" &&
        !(await hasPermission(actor, "accounts.manage"))
      ) {
        return json(request, {
          error:
            "Inviting retailer users requires Administrator, Operations, or Sales access.",
        }, 403);
      }
      if (current) {
        return json(request, {
          error:
            "That email already has portal access. An Administrator must change an existing account.",
        }, 409);
      }
      const assignedStores = await storesForAssignment(org, role, locations);
      if (!target) {
        const { data, error } = await service.auth.admin.inviteUserByEmail(
          email,
          { data: { full_name: text(body.fullName, 160) } },
        );
        if (error || !data.user) {
          throw error ?? new Error("The invitation did not create a user.");
        }
        target = data.user as unknown as Row;
      }
      const profile = {
        id: target.id,
        full_name: text(body.fullName, 160) || email,
        org,
        role,
        locations,
        active: true,
        staff_role: null,
      };
      const { error: profileError } = await service.from("portal_profile")
        .upsert(profile, { onConflict: "id" });
      if (profileError) throw profileError;
      await syncStoreAssignments(String(target.id), assignedStores);
      const existingMetadata = target.app_metadata && typeof target.app_metadata === "object"
        ? target.app_metadata as Row
        : {};
      await service.auth.admin.updateUserById(String(target.id), {
        ban_duration: "none",
        app_metadata: {
          ...existingMetadata,
          portal_account_type: accountType,
          portal_access_expires_on: accountType === "contractor" ? accessExpiresOn : null,
        },
      });
      await audit(actor, "invite-user", { ...target, email }, {
        org,
        role,
        locations,
        accountType,
        accessExpiresOn: accountType === "contractor" ? accessExpiresOn : null,
      });
      return json(request, {
        ok: true,
        user: {
          id: target.id,
          email,
          org,
          role,
          locations,
          accountType,
          accessExpiresOn: accountType === "contractor" ? accessExpiresOn : null,
        },
      });
    }

    if (action === "update-user") {
      if (
        actor.role === "internal" &&
        !(await hasPermission(actor, "users.manage"))
      ) {
        return json(request, {
          error:
            "Only an Administrator may change roles, store assignments, or account state.",
        }, 403);
      }
      if (actor.role !== "internal" && body.active !== false) {
        return json(request, {
          error:
            "Store Owners may deactivate their own users, but only an Administrator may change roles or store assignments.",
        }, 403);
      }
      if (!target || !current) {
        return json(request, { error: "User not found" }, 404);
      }
      if (String(target.id) === String(actor.id) && body.active === false) {
        return json(request, {
          error: "You cannot deactivate your own account.",
        }, 409);
      }
      if (actor.role !== "internal") {
        if (!new Set(["buyer", "budtender"]).has(String(current.role))) {
          return json(request, {
            error:
              "Store Owners may deactivate current Buyers and Budtenders only.",
          }, 403);
        }
        const { error: profileError } = await service.from("portal_profile")
          .update({ active: false }).eq("id", target.id);
        if (profileError) throw profileError;
        const { error: authError } = await service.auth.admin.updateUserById(
          String(target.id),
          { ban_duration: "876000h" },
        );
        if (authError) throw authError;
        await audit(actor, "deactivate-user", { ...target, email }, {
          org: current.org,
          role: current.role,
          locations: current.locations,
          active: false,
        });
        return json(request, {
          ok: true,
          user: {
            id: target.id,
            email,
            org: current.org,
            role: current.role,
            locations: current.locations,
            active: false,
          },
        });
      }
      const assignedStores = await storesForAssignment(org, role, locations);
      const active = body.active !== false;
      const { error: profileError } = await service.from("portal_profile")
        .update({ org, role, locations, active, staff_role: null }).eq(
          "id",
          target.id,
        );
      if (profileError) throw profileError;
      await syncStoreAssignments(String(target.id), assignedStores);
      const { error: authError } = await service.auth.admin.updateUserById(
        String(target.id),
        { ban_duration: active ? "none" : "876000h" },
      );
      if (authError) throw authError;
      await audit(actor, active ? "update-user" : "deactivate-user", {
        ...target,
        email,
      }, { org, role, locations, active });
      return json(request, {
        ok: true,
        user: { id: target.id, email, org, role, locations, active },
      });
    }

    return json(request, { error: "Unsupported action" }, 400);
  } catch (error) {
    if (!(error instanceof AdminError)) console.error("portal-admin", error);
    return json(request, {
      error: error instanceof AdminError
        ? error.message
        : "The access service is temporarily unavailable.",
    }, error instanceof AdminError ? error.status : 500);
  }
});
