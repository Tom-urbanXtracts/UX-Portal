import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManage: boolean };

function allowedOrigin(request: Request): string {
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

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uuidOrNull(value: unknown): string | null {
  const candidate = clean(value, 40);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(candidate)
    ? candidate
    : null;
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile")
    .select("id,full_name,org,role,staff_role,active")
    .eq("id", user.id).maybeSingle();
  if (
    !profile || profile.active === false || profile.role !== "internal" ||
    !profile.staff_role
  ) return null;
  const { data: readGrant } = await service.from("portal_role_permission")
    .select("permission").eq("staff_role", profile.staff_role).eq(
      "permission",
      "inventory.read",
    ).maybeSingle();
  if (!readGrant) return null;
  const { data: manageGrant } = await service.from("portal_role_permission")
    .select("permission").eq("staff_role", profile.staff_role).eq(
      "permission",
      "economics.manage",
    ).maybeSingle();
  return { user, profile: profile as Row, canManage: !!manageGrant };
}

async function snapshot(): Promise<Row> {
  const [partyResult, ownershipResult, brandPartnerResult] = await Promise.all([
    service.from("portal_economic_party")
      .select(
        "id,party_code,display_name,legal_name,party_type,active,updated_at",
      )
      .order("active", { ascending: false }).order("display_name"),
    service.from("portal_inventory_ownership")
      .select(
        "id,scope_type,canix_item_id,canix_package_id,economic_owner_party_id,commercial_model,settlement_counterparty_party_id,source_system,source_field,note,effective_from,updated_at",
      )
      .is("effective_to", null).order("updated_at", { ascending: false }),
    service.from("portal_brand_economic_partner")
      .select(
        "brand_key,canix_brand_id,canix_brand_name,economic_partner_party_id,source_system,is_current,last_seen_at",
      )
      .order("is_current", { ascending: false }).order("canix_brand_name"),
  ]);
  if (partyResult.error) throw partyResult.error;
  if (ownershipResult.error) throw ownershipResult.error;
  if (brandPartnerResult.error) throw brandPartnerResult.error;
  return {
    parties: partyResult.data ?? [],
    ownership: ownershipResult.data ?? [],
    brandPartners: brandPartnerResult.data ?? [],
  };
}

async function audit(
  caller: Caller,
  action: string,
  detail: Row,
): Promise<void> {
  const { error } = await service.from("portal_admin_audit").insert({
    actor_id: caller.profile.id,
    actor_org: caller.profile.org,
    action,
    target_id: null,
    target_email: null,
    target_org: null,
    detail,
  });
  if (error) throw error;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Forbidden" }, 403);
    if (request.method === "GET") {
      return json(request, {
        ...(await snapshot()),
        canManage: caller.canManage,
      });
    }
    if (!caller.canManage) {
      return json(request, {
        error:
          "Economic ownership changes require Administrator, Operations, or Sales access.",
      }, 403);
    }

    const body = await request.json() as Row;
    const action = clean(body.action, 40).toLowerCase();
    if (action === "sync-brand-partners") {
      const { data, error } = await service.rpc(
        "portal_sync_brand_economic_partners",
      );
      if (error) throw error;
      await audit(caller, "economic-partners-synced-from-canix", {
        sourceSystem: "canix_brand",
        result: data,
      });
      return json(request, { ok: true, sync: data, ...(await snapshot()) });
    }

    if (action === "upsert-party") {
      const id = uuidOrNull(body.id);
      const partyCode = clean(body.partyCode, 40).toUpperCase().replace(
        /[^A-Z0-9_-]/g,
        "_",
      );
      const displayName = clean(body.displayName, 200);
      const legalName = clean(body.legalName, 300) || null;
      const partyType = clean(body.partyType, 40);
      const active = body.active !== false;
      if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(partyCode) || !displayName) {
        return json(request, {
          error: "Party code and display name are required.",
        }, 400);
      }
      if (
        !new Set([
          "urbanxtracts",
          "brand_partner",
          "contract_manufacturer",
          "other",
        ]).has(partyType)
      ) {
        return json(
          request,
          { error: "Unsupported economic party type." },
          400,
        );
      }
      let existing: Row | null = null;
      if (id) {
        const { data, error } = await service.from("portal_economic_party")
          .select("id,party_code,party_type").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!data) {
          return json(request, { error: "Economic party not found." }, 404);
        }
        existing = data as unknown as Row;
      } else {
        const { data, error } = await service.from("portal_economic_party")
          .select("id").eq("party_code", partyCode).maybeSingle();
        if (error) throw error;
        if (data) {
          return json(request, {
            error:
              "That party code already exists. Edit the existing party instead.",
          }, 409);
        }
      }
      const protectedInternalParty = partyCode === "URBANXTRACTS" ||
        partyType === "urbanxtracts" ||
        existing?.party_code === "URBANXTRACTS" ||
        existing?.party_type === "urbanxtracts";
      if (existing && partyCode !== existing.party_code) {
        return json(request, {
          error:
            "Party codes are permanent. Create a new party instead of renaming the code.",
        }, 400);
      }
      if (
        protectedInternalParty &&
        (partyCode !== "URBANXTRACTS" || partyType !== "urbanxtracts" ||
          !active)
      ) {
        return json(request, {
          error:
            "The urbanXtracts economic party cannot be renamed, retyped, or deactivated.",
        }, 400);
      }
      const record = {
        party_code: partyCode,
        display_name: displayName,
        legal_name: legalName,
        party_type: partyType,
        active,
        updated_by: caller.profile.id,
        ...(id ? {} : { created_by: caller.profile.id }),
        updated_at: new Date().toISOString(),
      };
      const mutation = id
        ? service.from("portal_economic_party").update(record).eq("id", id)
        : service.from("portal_economic_party").insert(record);
      const { data, error } = await mutation.select("*").single();
      if (error) {
        if (error.code === "23505") {
          return json(
            request,
            { error: "That party code already exists." },
            409,
          );
        }
        throw error;
      }
      await audit(caller, "economic-party-saved", {
        partyId: data.id,
        partyCode,
        displayName,
        partyType,
        active,
      });
      return json(
        request,
        { ok: true, party: data, ...(await snapshot()) },
        id ? 200 : 201,
      );
    }

    if (action === "set-ownership") {
      const scopeType = clean(body.scopeType, 20);
      const canixItemId = integerOrNull(body.canixItemId);
      const canixPackageId = integerOrNull(body.canixPackageId);
      const economicOwnerPartyId = body.economicOwnerPartyId
        ? uuidOrNull(body.economicOwnerPartyId)
        : null;
      const settlementCounterpartyPartyId = body.settlementCounterpartyPartyId
        ? uuidOrNull(body.settlementCounterpartyPartyId)
        : null;
      const commercialModel = clean(body.commercialModel, 50) || null;
      const sourceSystem = clean(body.sourceSystem, 40) || "portal";
      const sourceField = clean(body.sourceField, 120) || null;
      const note = clean(body.note, 1500) || null;
      if (!new Set(["item", "package"]).has(scopeType)) {
        return json(
          request,
          { error: "Choose an item or package scope." },
          400,
        );
      }
      if (scopeType === "item" && (!canixItemId || canixPackageId)) {
        return json(request, {
          error: "Item scope requires only a Canix item id.",
        }, 400);
      }
      if (scopeType === "package" && !canixPackageId) {
        return json(request, {
          error: "Package scope requires a Canix package id.",
        }, 400);
      }
      if (body.economicOwnerPartyId && !economicOwnerPartyId) {
        return json(request, { error: "Economic Owner is invalid." }, 400);
      }
      if (
        body.settlementCounterpartyPartyId && !settlementCounterpartyPartyId
      ) {
        return json(
          request,
          { error: "Settlement counterparty is invalid." },
          400,
        );
      }
      if (
        economicOwnerPartyId &&
        settlementCounterpartyPartyId === economicOwnerPartyId
      ) {
        return json(request, {
          error:
            "Economic Owner and Settlement Counterparty must be different parties.",
        }, 400);
      }
      const partyIds = Array.from(
        new Set(
          [economicOwnerPartyId, settlementCounterpartyPartyId].filter(Boolean),
        ),
      ) as string[];
      if (partyIds.length) {
        const { data, error } = await service.from("portal_economic_party")
          .select("id,active").in("id", partyIds);
        if (error) throw error;
        if (
          (data ?? []).length !== partyIds.length ||
          (data ?? []).some((party) => party.active === false)
        ) {
          return json(request, {
            error: "Ownership assignments require active economic parties.",
          }, 400);
        }
      }
      if (scopeType === "item") {
        const { data, error } = await service.from("canix_package_current")
          .select("item_id").eq("item_id", canixItemId).limit(1);
        if (error) throw error;
        if (!data?.length) {
          return json(request, {
            error: "Canix item not found in the current inventory snapshot.",
          }, 404);
        }
      } else {
        const { data, error } = await service.from("canix_package_current")
          .select("package_id,item_id").eq("package_id", canixPackageId)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          return json(request, {
            error: "Canix package not found in the current inventory snapshot.",
          }, 404);
        }
        if (canixItemId && Number(data.item_id) !== canixItemId) {
          return json(request, {
            error: "The Canix item does not match this package.",
          }, 409);
        }
      }
      const { data, error } = await service.rpc(
        "portal_set_inventory_ownership",
        {
          p_scope_type: scopeType,
          p_canix_item_id: canixItemId,
          p_canix_package_id: canixPackageId,
          p_economic_owner_party_id: economicOwnerPartyId,
          p_commercial_model: commercialModel,
          p_settlement_counterparty_party_id: settlementCounterpartyPartyId,
          p_source_system: sourceSystem,
          p_source_field: sourceField,
          p_note: note,
          p_actor_id: caller.profile.id,
          p_actor_email: caller.user.email ?? null,
        },
      );
      if (error) throw error;
      await audit(caller, "inventory-economic-ownership-set", {
        scopeType,
        canixItemId,
        canixPackageId,
        economicOwnerPartyId,
        commercialModel,
        settlementCounterpartyPartyId,
        sourceSystem,
        sourceField,
      });
      return json(request, {
        ok: true,
        ownership: data,
        ...(await snapshot()),
      });
    }

    return json(request, { error: "Unsupported ownership action" }, 400);
  } catch (error) {
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Unexpected economic ownership error",
    }, 500);
  }
});
