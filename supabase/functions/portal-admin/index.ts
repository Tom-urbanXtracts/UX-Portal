import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const EXTERNAL_ROLES = new Set(["owner", "buyer", "budtender"]);

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

async function actorFor(request: Request): Promise<Row | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json();
  const { data: profile } = await service.from("portal_profile").select(
    "id,role,staff_role,active,org,locations",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false) return null;
  if (profile.role !== "internal" && profile.role !== "owner") return null;
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
    const email = text(body.email, 320).toLowerCase();
    const org = text(body.org, 200);
    const roleLabel = text(body.role, 40);
    const role = ({
      "Store owner": "owner",
      "Buyer": "buyer",
      "Budtender": "budtender",
    } as Record<string, string>)[roleLabel] ?? roleLabel.toLowerCase();
    const locations = text(body.locations, 1000);
    if (!email || !email.includes("@") || !org) {
      return json(request, {
        error: "A valid email and organisation are required.",
      }, 400);
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
      await service.auth.admin.updateUserById(String(target.id), {
        ban_duration: "none",
      });
      await audit(actor, "invite-user", { ...target, email }, {
        org,
        role,
        locations,
      });
      return json(request, {
        ok: true,
        user: { id: target.id, email, org, role, locations },
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
