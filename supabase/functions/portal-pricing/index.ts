import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { canonicalCanixProductId } from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; canManagePricing: boolean };

class PricingError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(request: Request): string {
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

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
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

function clean(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
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
    .select("id,full_name,org,role,staff_role,active,locations")
    .eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false) return null;
  let canManagePricing = false;
  if (profile.role === "internal") {
    const { data: grant } = await service.from("portal_role_permission")
      .select("permission")
      .eq("staff_role", profile.staff_role)
      .eq("permission", "pricing.manage")
      .maybeSingle();
    canManagePricing = !!grant;
  }
  return { user, profile: profile as Row, canManagePricing };
}

async function accessibleStores(caller: Caller): Promise<Row[]> {
  if (caller.profile.role === "internal") {
    if (!caller.canManagePricing) return [];
    const { data, error } = await service.from("portal_store")
      .select("license_number,organization,display_name,active")
      .eq("active", true).order("organization").order("display_name");
    if (error) throw error;
    return (data ?? []) as unknown as Row[];
  }
  if (!new Set(["owner", "buyer"]).has(String(caller.profile.role))) return [];
  if (caller.profile.role === "owner") {
    const { data, error } = await service.from("portal_store")
      .select("license_number,organization,display_name,active")
      .eq("organization", caller.profile.org).eq("active", true).order(
        "display_name",
      );
    if (error) throw error;
    return (data ?? []) as unknown as Row[];
  }
  const { data: assignments, error: assignmentError } = await service.from(
    "portal_profile_store",
  )
    .select("license_number").eq("profile_id", caller.profile.id);
  if (assignmentError) throw assignmentError;
  const licenses = (assignments ?? []).map((row) => String(row.license_number));
  if (!licenses.length) return [];
  const { data, error } = await service.from("portal_store")
    .select("license_number,organization,display_name,active")
    .eq("organization", caller.profile.org).eq("active", true).in(
      "license_number",
      licenses,
    ).order("display_name");
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

function serializeProposal(row: Row): Row {
  return {
    id: row.id,
    organization: row.organization,
    locationLicense: row.location_license,
    locationName: row.location_name,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    currentPriceCents: row.current_price_cents,
    proposedPriceCents: row.proposed_price_cents,
    note: row.note,
    state: row.state,
    proposedByEmail: row.proposed_by_email,
    proposedByRole: row.proposed_by_role,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function serializePrice(row: Row): Row {
  return {
    organization: row.organization,
    locationLicense: row.location_license,
    locationName: row.location_name,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    priceCents: row.price_cents,
    publishedAt: row.published_at,
    sourceProposalId: row.source_proposal_id,
  };
}

async function pricingSnapshot(caller: Caller): Promise<Row> {
  const stores = await accessibleStores(caller);
  const licenses = stores.map((store) => String(store.license_number));
  if (!licenses.length) return { stores: [], proposals: [], prices: [] };
  const storeName = new Map(
    stores.map((store) => [String(store.license_number), store.display_name]),
  );
  const [proposalResult, priceResult] = await Promise.all([
    service.from("portal_price_proposal").select("*").in(
      "location_license",
      licenses,
    ).order("created_at", { ascending: false }).limit(250),
    service.from("portal_store_price").select("*").in(
      "location_license",
      licenses,
    ).order("published_at", { ascending: false }).limit(1000),
  ]);
  if (proposalResult.error) throw proposalResult.error;
  if (priceResult.error) throw priceResult.error;
  const proposals = (proposalResult.data ?? []).map((row) =>
    serializeProposal({
      ...row,
      location_name: storeName.get(String(row.location_license)),
    })
  );
  const prices = (priceResult.data ?? []).map((row) =>
    serializePrice({
      ...row,
      location_name: storeName.get(String(row.location_license)),
    })
  );
  return {
    stores: stores.map((store) => ({
      license: store.license_number,
      organization: store.organization,
      name: store.display_name,
    })),
    proposals,
    prices,
  };
}

async function audit(
  caller: Caller,
  action: string,
  proposal: Row,
  detail: Row,
): Promise<void> {
  const { error } = await service.from("portal_admin_audit").insert({
    actor_id: caller.profile.id,
    actor_org: caller.profile.org,
    action,
    target_id: null,
    target_email: proposal.proposed_by_email ?? null,
    target_org: proposal.organization ?? null,
    detail,
  });
  if (error) throw error;
}

async function canonicalProduct(
  productId: string,
): Promise<{ productId: string; productName: string; sku: string | null }> {
  const canonicalId = canonicalCanixProductId(productId);
  if (!canonicalId) {
    throw new PricingError(
      409,
      "Store pricing can be proposed only for a current Canix catalog item.",
    );
  }
  const { data: state, error: stateError } = await service.from(
    "canix_sync_state",
  )
    .select("last_successful_run_id").eq("id", 1).maybeSingle();
  if (stateError) throw stateError;
  if (!state?.last_successful_run_id) {
    throw new PricingError(
      503,
      "Canix catalog data is temporarily unavailable.",
    );
  }
  const { data, error } = await service.from("canix_package_current")
    .select("item_id,item_name,product_name,sku,source_updated_at")
    .eq("sync_run_id", state.last_successful_run_id).eq(
      "item_id",
      canonicalId.slice("canix:item:".length),
    )
    .eq("quantity_type", "CountBased").eq("status_category", "available")
    .gt("orderable_units", 0)
    .order("source_updated_at", { ascending: false, nullsFirst: false }).limit(
      1,
    );
  if (error) throw error;
  const row = data?.[0];
  if (!row) {
    throw new PricingError(
      409,
      "That Canix item is not present in the current catalog snapshot.",
    );
  }
  return {
    productId: canonicalId,
    productName: String(
      row.product_name || row.item_name || "Unnamed Canix item",
    ),
    sku: clean(row.sku, 120) || null,
  };
}

async function currentStorePrice(
  locationLicense: string,
  productId: string,
): Promise<number | null> {
  const { data, error } = await service.from("portal_store_price").select(
    "price_cents",
  )
    .eq("location_license", locationLicense).eq("product_id", productId)
    .maybeSingle();
  if (error) throw error;
  return data?.price_cents === null || data?.price_cents === undefined
    ? null
    : Number(data.price_cents);
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
      if (caller.profile.role === "internal" && !caller.canManagePricing) {
        return json(request, { error: "Forbidden" }, 403);
      }
      if (
        !new Set(["internal", "owner", "buyer"]).has(
          String(caller.profile.role),
        )
      ) return json(request, { error: "Forbidden" }, 403);
      return json(request, await pricingSnapshot(caller));
    }

    const body = await request.json() as Row;
    const action = clean(body.action, 30).toLowerCase();
    if (action === "propose") {
      if (!new Set(["owner", "buyer"]).has(String(caller.profile.role))) {
        return json(request, {
          error: "Only store owners and buyers may propose store pricing.",
        }, 403);
      }
      const stores = await accessibleStores(caller);
      const locationLicense = clean(body.locationLicense, 120);
      const store = stores.find((row) =>
        String(row.license_number) === locationLicense
      );
      if (!store || store.organization !== caller.profile.org) {
        return json(request, {
          error: "That store is outside your assigned access.",
        }, 403);
      }
      const productId = clean(body.productId, 240);
      const proposedPriceCents = Number(body.proposedPriceCents);
      const note = clean(body.note, 1200) || null;
      if (
        !productId || !Number.isInteger(proposedPriceCents) ||
        proposedPriceCents <= 0 || proposedPriceCents > 10000000
      ) {
        return json(request, {
          error: "Choose a product and enter a valid positive unit price.",
        }, 400);
      }
      const product = await canonicalProduct(productId);
      const currentPriceCents = await currentStorePrice(
        locationLicense,
        product.productId,
      );
      const { data, error } = await service.from("portal_price_proposal")
        .insert({
          organization: caller.profile.org,
          location_license: locationLicense,
          product_id: product.productId,
          product_name: product.productName,
          sku: product.sku,
          current_price_cents: currentPriceCents,
          proposed_price_cents: proposedPriceCents,
          note,
          proposed_by: caller.profile.id,
          proposed_by_email: caller.user.email ?? null,
          proposed_by_role: caller.profile.role,
        }).select("*").single();
      if (error) {
        if (error.code === "23505") {
          return json(request, {
            error:
              "A pending proposal already exists for this product and store.",
          }, 409);
        }
        throw error;
      }
      await audit(caller, "price-proposed", data as unknown as Row, {
        locationLicense,
        locationName: store.display_name,
        productId: product.productId,
        productName: product.productName,
        currentPriceCents,
        proposedPriceCents,
      });
      return json(request, {
        ok: true,
        proposal: serializeProposal({
          ...(data as unknown as Row),
          location_name: store.display_name,
        }),
      }, 201);
    }

    if (action === "approve" || action === "reject") {
      if (caller.profile.role !== "internal" || !caller.canManagePricing) {
        return json(request, {
          error:
            "Pricing approval requires Administrator, Operations, or Sales access.",
        }, 403);
      }
      const proposalId = clean(body.proposalId, 80);
      if (!proposalId) {
        return json(request, { error: "A pricing proposal is required." }, 400);
      }
      const { data: proposal, error: proposalError } = await service.from(
        "portal_price_proposal",
      ).select("*").eq("id", proposalId).maybeSingle();
      if (proposalError) throw proposalError;
      if (!proposal) {
        return json(request, { error: "Pricing proposal not found." }, 404);
      }
      if (action === "approve") {
        const currentProduct = await canonicalProduct(
          String(proposal.product_id),
        );
        if (
          currentProduct.productName !== proposal.product_name ||
          currentProduct.sku !== proposal.sku
        ) {
          return json(request, {
            error:
              "The Canix product identity changed after this proposal was submitted. Create a new proposal.",
          }, 409);
        }
        const livePriceCents = await currentStorePrice(
          String(proposal.location_license),
          String(proposal.product_id),
        );
        const proposedFromPrice = proposal.current_price_cents === null ||
            proposal.current_price_cents === undefined
          ? null
          : Number(proposal.current_price_cents);
        if (livePriceCents !== proposedFromPrice) {
          return json(request, {
            error:
              "The published store price changed after this proposal was submitted. Create a new proposal.",
          }, 409);
        }
      }
      const decision = action === "approve" ? "approved" : "rejected";
      const decisionNote = clean(body.note, 1200) || null;
      const { data, error } = await service.rpc(
        "portal_decide_price_proposal",
        {
          p_proposal_id: proposalId,
          p_actor_id: caller.profile.id,
          p_decision: decision,
          p_note: decisionNote,
        },
      );
      if (error) throw error;
      await audit(
        caller,
        action === "approve" ? "price-approved" : "price-rejected",
        proposal as unknown as Row,
        {
          proposalId,
          locationLicense: proposal.location_license,
          productId: proposal.product_id,
          proposedPriceCents: proposal.proposed_price_cents,
          decisionNote,
        },
      );
      return json(request, {
        ok: true,
        decision: data,
        ...(await pricingSnapshot(caller)),
      });
    }

    return json(request, { error: "Unsupported pricing action" }, 400);
  } catch (error) {
    const status = error instanceof PricingError ? error.status : 500;
    return json(request, {
      error: error instanceof PricingError
        ? error.message
        : "The pricing service is temporarily unavailable.",
    }, status);
  }
});
