import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;

class ProfileError extends Error {
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
    vary: "Origin",
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

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inventoryBucket(row: Row): "packaged" | "bulk" | "plant_material" {
  const name = clean(row.item_name, 500);
  if (/\b(?:clone|biomass|seeds?)\b/i.test(name)) return "plant_material";
  if (
    /\bbulk\b/i.test([name, row.item_category_name].filter(Boolean).join(" "))
  ) {
    return "bulk";
  }
  return "packaged";
}

async function actorFor(request: Request): Promise<Row> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new ProfileError(403, "Forbidden");
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok || !verifiedTokenIsAuthenticated(authorization)) {
    throw new ProfileError(403, "Forbidden");
  }
  const user = await response.json() as Row;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,role,staff_role,active,org").eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (
    !profile || profile.active === false ||
    !["internal", "brand"].includes(String(profile.role))
  ) {
    throw new ProfileError(403, "Forbidden");
  }
  return profile as Row;
}

async function permissionSet(
  actor: Row,
  organizationId: string,
): Promise<Set<string>> {
  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new ProfileError(400, "Choose a valid Brand organization.");
  }
  const { data: organization, error: organizationError } = await service
    .from("portal_organization").select("id,kind,status")
    .eq("id", organizationId).eq("kind", "brand").eq("status", "active")
    .maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) {
    throw new ProfileError(404, "Active Brand organization not found.");
  }

  if (actor.role === "internal" && actor.staff_role === "administrator") {
    const { data: grant } = await service.from("portal_role_permission")
      .select("permission").eq("staff_role", actor.staff_role)
      .eq("permission", "users.manage").maybeSingle();
    if (grant) {
      return new Set(["brand.inventory.read", "brand.financials.read"]);
    }
  }

  const { data: membership, error: membershipError } = await service
    .from("portal_organization_membership").select("member_role")
    .eq("profile_id", actor.id).eq("organization_id", organizationId)
    .eq("workspace", "brand").eq("status", "active").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) {
    throw new ProfileError(403, "This Brand is outside your access scope.");
  }
  const { data: grants, error: grantError } = await service
    .from("portal_workspace_role_permission").select("permission")
    .eq("workspace", "brand").eq("member_role", membership.member_role)
    .in("permission", ["brand.inventory.read", "brand.financials.read"]);
  if (grantError) throw grantError;
  return new Set((grants ?? []).map((grant) => String(grant.permission)));
}

async function allScopedPackages(runId: string, account: Row): Promise<Row[]> {
  const ownerId = clean(account.canix_owner_id, 40);
  if (!/^\d+$/.test(ownerId)) return [];
  const rows: Row[] = [];
  for (let start = 0;; start += 1000) {
    const { data, error } = await service.from("canix_package_current")
      .select(
        "package_id,item_id,item_name,item_category_name,brand_id,brand_name,canix_package_owner_id,canix_package_owner_name,quantity_type,status,status_category,reservation_state,facility_id,facility_name,source_updated_at",
      )
      .eq("sync_run_id", runId)
      .neq("facility_id", 4546).eq("canix_package_owner_id", Number(ownerId))
      .order("source_updated_at", { ascending: false, nullsFirst: false })
      .range(start, start + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function inventoryProfile(rows: Row[]): Row {
  const grouped = new Map<string, Row>();
  const totals = {
    records: 0,
    items: 0,
    available: 0,
    allocated: 0,
    inProgress: 0,
    packaged: 0,
    bulk: 0,
    plantMaterial: 0,
  };
  for (const row of rows) {
    totals.records += 1;
    const status = clean(row.status_category, 60).toLowerCase();
    if (status === "available") totals.available += 1;
    else if (status === "allocated") totals.allocated += 1;
    else totals.inProgress += 1;
    const bucket = inventoryBucket(row);
    if (bucket === "bulk") totals.bulk += 1;
    else if (bucket === "plant_material") totals.plantMaterial += 1;
    else totals.packaged += 1;
    const key = clean(row.item_id, 80) ||
      `name:${clean(row.item_name, 300).toLowerCase()}`;
    const current = grouped.get(key) ?? {
      itemId: row.item_id ?? null,
      itemName: clean(row.item_name, 300) || "Unnamed Canix item",
      brandName: clean(row.brand_name, 200) || "Brand not recorded",
      ownerName: clean(row.canix_package_owner_name, 200) || null,
      category: clean(row.item_category_name, 160) || "Not classified",
      inventoryBucket: bucket,
      packageRecords: 0,
      availableRecords: 0,
      allocatedRecords: 0,
      inProgressRecords: 0,
      lastUpdatedAt: row.source_updated_at ?? null,
    };
    current.packageRecords = count(current.packageRecords) + 1;
    if (status === "available") {
      current.availableRecords = count(current.availableRecords) + 1;
    } else if (status === "allocated") {
      current.allocatedRecords = count(current.allocatedRecords) + 1;
    } else current.inProgressRecords = count(current.inProgressRecords) + 1;
    if (
      String(row.source_updated_at ?? "") > String(current.lastUpdatedAt ?? "")
    ) {
      current.lastUpdatedAt = row.source_updated_at;
    }
    grouped.set(key, current);
  }
  const items = [...grouped.values()].sort((a, b) =>
    String(a.itemName).localeCompare(String(b.itemName))
  );
  totals.items = items.length;
  return {
    totals,
    items,
    quantityVisibility: "withheld_pending_decision",
    quantityDecision:
      "Exact weights and unit quantities remain hidden until Brand inventory visibility is approved in the decision register.",
    productionScope:
      "Production facilities only; Canix sandbox records are excluded.",
  };
}

function testBrandInventory(): Row {
  const items = [
    ["990001", "Test Brand Citrus Gummies 10-Pack", "Edibles", 42, 35, 7],
    ["990002", "Test Brand Live Resin Vape 1g", "Vaporizers", 31, 24, 7],
    ["990003", "Test Brand Nighttime Gummies 10-Pack", "Edibles", 18, 12, 6],
    ["990004", "Test Brand Infused Pre-Rolls 5-Pack", "Pre-Rolls", 25, 19, 6],
  ].map(([itemId, itemName, category, packages, available, allocated]) => ({
    itemId,
    itemName,
    brandName: "Test Brand",
    ownerName: "Test Brand",
    category,
    inventoryBucket: "packaged",
    packageRecords: packages,
    availableRecords: available,
    allocatedRecords: allocated,
    inProgressRecords: 0,
    lastUpdatedAt: new Date().toISOString(),
    demo: true,
  }));
  return {
    totals: {
      records: 116,
      items: 4,
      available: 90,
      allocated: 26,
      inProgress: 0,
      packaged: 116,
      bulk: 0,
      plantMaterial: 0,
    },
    items,
    quantityVisibility: "record_counts_only",
    quantityDecision: "DEMO — finished-goods record counts only.",
    productionScope: "Synthetic Test Brand finished goods; no Canix query was made.",
  };
}

async function brandProfile(actor: Row, organizationId: string): Promise<Row> {
  const permissions = await permissionSet(actor, organizationId);
  if (!permissions.size) {
    throw new ProfileError(403, "Your Brand role cannot read this profile.");
  }
  const [organizationResult, accountResult, syncResult] = await Promise.all([
    service.from("portal_organization").select(
      "id,legal_name,display_name,status",
    )
      .eq("id", organizationId).single(),
    service.from("portal_brand_account").select("*")
      .eq("organization_id", organizationId).maybeSingle(),
    service.from("canix_sync_state").select(
      "status,last_successful_run_id,last_successful_at,latest_source_updated_at,last_error",
    )
      .eq("id", 1).maybeSingle(),
  ]);
  if (organizationResult.error) throw organizationResult.error;
  if (accountResult.error) throw accountResult.error;
  if (syncResult.error) throw syncResult.error;
  const organization = organizationResult.data as Row;
  const account = accountResult.data as Row | null;
  const sync = syncResult.data as Row | null;
  const verified = account?.scope_status === "verified";
  const demoTenant = organization.legal_name === "Test Brand";
  let inventory: Row | null = null;
  if (permissions.has("brand.inventory.read") && demoTenant) {
    inventory = testBrandInventory();
  } else if (
    permissions.has("brand.inventory.read") && verified &&
    sync?.last_successful_run_id
  ) {
    inventory = inventoryProfile(
      await allScopedPackages(String(sync.last_successful_run_id), account),
    );
  }
  return {
    organization: {
      id: organization.id,
      legalName: organization.legal_name,
      displayName: organization.display_name,
      status: organization.status,
    },
    sourceScope: account
      ? {
        status: account.scope_status,
        canixBrandId: account.canix_brand_id,
        canixBrandName: account.canix_brand_name,
        canixOwnerId: account.canix_owner_id,
        canixOwnerName: account.canix_owner_name,
        mondayBrandItemId: account.monday_account_item_id,
        note: account.scope_note,
      }
      : { status: "pending", note: "Brand source mapping is not configured." },
    inventory,
    inventorySource: permissions.has("brand.inventory.read")
      ? {
        available: demoTenant || (verified && !!sync?.last_successful_run_id),
        scope: demoTenant ? "synthetic_demo" : "canix_owner_only",
        syncStatus: demoTenant ? "demo" : sync?.status ?? "not_configured",
        lastSuccessfulAt: demoTenant ? new Date().toISOString() : sync?.last_successful_at ?? null,
        latestCanixRecordAt: demoTenant ? new Date().toISOString() : sync?.latest_source_updated_at ?? null,
      }
      : null,
    financials: permissions.has("brand.financials.read")
      ? {
        accountingClassification: "Company-owned Brand",
        quickBooksRelationship: "No external accounting party",
        openBalance: { state: "not_applicable", label: "Not applicable" },
        statements: { state: "not_applicable", label: "Not applicable" },
        settlements: { state: "not_required", label: "Not required" },
        supportingRecords: {
          state: "internal_only",
          label: "Internal company books",
        },
        amountsVisible: false,
        explanation:
          "urbanXtracts is the company-owned Brand. It is not mapped to an external QuickBooks customer or vendor, so Brand settlements, statements, and external balances do not apply. Company-level QuickBooks records remain available only in authorized Internal views.",
      }
      : null,
    permissions: [...permissions],
  };
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
    const body = await request.json() as Row;
    const organizationId = clean(body.organizationId, 80);
    return json(request, await brandProfile(actor, organizationId));
  } catch (error) {
    if (!(error instanceof ProfileError)) {
      console.error("portal-brand-profile", error);
    }
    return json(request, {
      error: error instanceof ProfileError
        ? error.message
        : "The Brand profile is temporarily unavailable.",
    }, error instanceof ProfileError ? error.status : 500);
  }
});
