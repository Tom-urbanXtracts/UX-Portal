import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { labFailed, labPassed } from "../_shared/security-contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAKE_WEBHOOK_URL = Deno.env.get("MAKE_WEBHOOK_URL") ?? "";
const MAKE_INTAKE_SECRET = Deno.env.get("MAKE_INTAKE_SECRET") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const KINDS = new Set(["order", "onboarding", "license", "recall"]);

type Row = Record<string, unknown>;

class IntakeError extends Error {
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
    "access-control-allow-methods": "POST, OPTIONS",
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

async function identity(
  request: Request,
): Promise<{ user: Row; profile: Row } | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active,locations",
  ).eq("id", user.id).maybeSingle();
  return profile && profile.active !== false
    ? { user, profile: profile as Row }
    : null;
}

async function hasPermission(
  profile: Row,
  permission: string,
): Promise<boolean> {
  if (profile.role !== "internal") return false;
  const { data } = await service.from("portal_role_permission").select(
    "permission",
  )
    .eq("staff_role", profile.staff_role).eq("permission", permission)
    .maybeSingle();
  return !!data;
}

async function canSubmit(kind: string, profile: Row): Promise<boolean> {
  if (kind === "order") {
    return ["owner", "buyer"].includes(String(profile.role)) ||
      (profile.role === "internal" &&
        await hasPermission(profile, "orders.manage"));
  }
  if (kind === "license") {
    return ["owner", "buyer", "internal"].includes(String(profile.role));
  }
  if (kind === "recall") {
    return profile.role === "internal" &&
      await hasPermission(profile, "quality.manage");
  }
  return true;
}

async function verifyOrder(
  payload: Row,
  caller: { user: Row; profile: Row },
): Promise<Row> {
  const license = String(payload.licenceNumber || "").trim();
  if (!license) throw new IntakeError(400, "A licensed store is required.");
  const { data: store, error: storeError } = await service.from("portal_store")
    .select(
      "license_number,organization,display_name,active,approval_threshold_cents,enforce_case_quantity,retailer_account_id,license_status,ordering_status",
    )
    .eq("license_number", license).maybeSingle();
  if (storeError) throw storeError;
  if (!store || store.active === false) {
    throw new IntakeError(403, "That store is not active for portal ordering.");
  }
  if (store.license_status !== "active") {
    throw new IntakeError(
      403,
      "That store license has not been qualified for portal ordering.",
    );
  }
  if (store.ordering_status !== "ready") {
    throw new IntakeError(403, "Ordering is not enabled for that store.");
  }
  if (!store.retailer_account_id) {
    throw new IntakeError(
      403,
      "That store is not linked to a qualified retailer account.",
    );
  }
  const { data: retailerAccount, error: retailerError } = await service.from(
    "portal_retailer_account",
  )
    .select("portal_status,quickbooks_customer_id").eq(
      "id",
      store.retailer_account_id,
    ).maybeSingle();
  if (retailerError) throw retailerError;
  if (retailerAccount?.portal_status !== "ready_to_order") {
    throw new IntakeError(
      403,
      "That retailer account is not ready for portal ordering.",
    );
  }
  if (retailerAccount.quickbooks_customer_id) {
    const { data: quickbooksCustomer, error: quickbooksError } = await service
      .from("quickbooks_customer_cache")
      .select("active").eq(
        "quickbooks_customer_id",
        retailerAccount.quickbooks_customer_id,
      ).maybeSingle();
    if (quickbooksError) throw quickbooksError;
    if (!quickbooksCustomer || quickbooksCustomer.active === false) {
      throw new IntakeError(
        403,
        "That QuickBooks customer is inactive, so portal ordering is paused.",
      );
    }
  }
  if (
    caller.profile.role !== "internal" &&
    store.organization !== caller.profile.org
  ) {
    throw new IntakeError(403, "That store is outside your organization.");
  }
  if (caller.profile.role === "buyer") {
    const { data: assignment } = await service.from("portal_profile_store")
      .select("license_number")
      .eq("profile_id", caller.profile.id).eq("license_number", license)
      .maybeSingle();
    if (!assignment) {
      throw new IntakeError(403, "That store is outside your assigned access.");
    }
  }

  const rawLines = Array.isArray(payload.lines) ? payload.lines as Row[] : [];
  if (!rawLines.length || rawLines.length > 250) {
    throw new IntakeError(
      400,
      "An order must contain between one and 250 lines.",
    );
  }
  const productIds = Array.from(
    new Set(
      rawLines.map((line) => String(line.productId || "").trim()).filter(
        Boolean,
      ),
    ),
  );
  if (
    productIds.length !== rawLines.length &&
    rawLines.some((line) => !String(line.productId || "").trim())
  ) {
    throw new IntakeError(
      400,
      "Every order line must include its catalog product identifier.",
    );
  }
  const { data: prices, error: priceError } = await service.from(
    "portal_store_price",
  )
    .select("product_id,product_name,sku,price_cents,published_at")
    .eq("location_license", license).in("product_id", productIds);
  if (priceError) throw priceError;
  const priceByProduct = new Map(
    (prices ?? []).map((row) => [String(row.product_id), row]),
  );
  const missingPrice = productIds.find((productId) =>
    !priceByProduct.has(productId)
  );
  if (missingPrice) {
    throw new IntakeError(
      409,
      "A product in this draft no longer has an approved price for this store. Refresh the catalog and review the draft.",
    );
  }

  const requestedByProduct = new Map(productIds.map((productId) => [
    productId,
    rawLines.filter((line) => String(line.productId || "").trim() === productId)
      .reduce((sum, line) => sum + (Number(line.quantity) || 0), 0),
  ]));
  const canixProductIds = productIds.filter((id) =>
    id.startsWith("canix:item:")
  );
  const numericItemIds = canixProductIds.map((id) =>
    id.slice("canix:item:".length)
  ).filter((id) => /^\d+$/.test(id));
  const releasedUnitsByProduct = new Map<string, number>();
  if (canixProductIds.length) {
    const { data: sync } = await service.from("canix_sync_state").select(
      "last_successful_run_id",
    ).eq("id", 1).maybeSingle();
    if (!sync?.last_successful_run_id) {
      throw new IntakeError(
        503,
        "Canix release data is temporarily unavailable. The draft was preserved.",
      );
    }
    if (numericItemIds.length) {
      const { data: packages, error: packageError } = await service.from(
        "canix_package_current",
      )
        .select(
          "item_id,status_category,quantity_type,weight,c_reserved_weight,reservation_state,orderable_units,case_quantity,case_quantity_unit,lab_test_status,test_result_status,has_coa",
        )
        .eq("sync_run_id", sync.last_successful_run_id).eq(
          "status_category",
          "available",
        )
        .eq("quantity_type", "CountBased").in("item_id", numericItemIds);
      if (packageError) throw packageError;
      for (const itemId of numericItemIds) {
        const matching = (packages ?? []).filter((row) => {
          const explicitOrderable =
            row.orderable_units === null || row.orderable_units === undefined
              ? Number(row.weight)
              : Number(row.orderable_units);
          return String(row.item_id) === itemId &&
            Number.isFinite(explicitOrderable) && explicitOrderable > 0 &&
            !labFailed(row as unknown as Row);
        });
        if (!matching.length) {
          throw new IntakeError(
            409,
            "A Canix product in this draft is no longer available. Refresh the catalog and review the draft.",
          );
        }
        const releasedUnits = matching.filter((row) =>
          labPassed(row as unknown as Row)
        )
          .reduce((sum, row) => {
            const value =
              row.orderable_units === null || row.orderable_units === undefined
                ? row.weight
                : row.orderable_units;
            return sum + Math.max(0, Number(value) || 0);
          }, 0);
        releasedUnitsByProduct.set(`canix:item:${itemId}`, releasedUnits);
        const requested = requestedByProduct.get(`canix:item:${itemId}`) ?? 0;
        const available = matching.reduce((sum, row) => {
          const value =
            row.orderable_units === null || row.orderable_units === undefined
              ? row.weight
              : row.orderable_units;
          return sum + Math.max(0, Number(value) || 0);
        }, 0);
        if (requested > available) {
          throw new IntakeError(
            409,
            "A requested product exceeds current orderable Canix inventory. The draft was preserved; reduce the quantity or contact Sales.",
          );
        }
        if (store.enforce_case_quantity === true) {
          const caseQuantities = Array.from(
            new Set(
              matching.map((row) => Number(row.case_quantity))
                .filter((value) => Number.isSafeInteger(value) && value > 0),
            ),
          );
          if (caseQuantities.length !== 1) {
            throw new IntakeError(
              409,
              "Case enforcement is enabled for this store, but Canix does not provide one unambiguous case quantity for a product in this draft. Contact Sales.",
            );
          }
          if (requested % caseQuantities[0] !== 0) {
            throw new IntakeError(
              409,
              `This store orders ${
                caseQuantities[0]
              } units per case for a product in this draft. Adjust the quantity to a whole-case multiple.`,
            );
          }
        }
      }
    }
    for (const productId of canixProductIds) {
      if (!releasedUnitsByProduct.has(productId)) {
        releasedUnitsByProduct.set(productId, 0);
      }
    }
  }

  let orderValueCents = 0;
  const verifiedLines = rawLines.map((line) => {
    const productId = String(line.productId || "").trim();
    const price = priceByProduct.get(productId)!;
    const quantity = Number(line.quantity);
    const submittedPrice = Number(line.unitPriceCents);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 9999) {
      throw new IntakeError(
        400,
        "Every order quantity must be a positive whole number below 10,000.",
      );
    }
    if (
      !Number.isInteger(submittedPrice) ||
      submittedPrice !== Number(price.price_cents)
    ) {
      throw new IntakeError(
        409,
        "A published store price changed after this draft was built. Refresh the draft before submitting.",
      );
    }
    orderValueCents += Number(price.price_cents) * quantity;
    const preorder = productId.startsWith("canix:item:") &&
      (requestedByProduct.get(productId) ?? quantity) >
        (releasedUnitsByProduct.get(productId) ?? 0);
    return {
      productId,
      product: price.product_name,
      sku: price.sku,
      // Retailers inspect lot records but never allocate a specific lot. The
      // fulfillment workflow writes the compliance tag after urbanXtracts
      // allocates the package in Canix/Monday.
      tag: "",
      quantity,
      unit: "each",
      unitPriceCents: Number(price.price_cents),
      lineTotalCents: Number(price.price_cents) * quantity,
      orderMode: preorder ? "preorder" : "standard",
      releaseState: preorder ? "awaiting_release" : "released",
    };
  });
  const preorderProductIds = verifiedLines.filter((line) =>
    line.orderMode === "preorder"
  ).map((line) => line.productId);
  const threshold = store.approval_threshold_cents === null ||
      store.approval_threshold_cents === undefined
    ? null
    : Number(store.approval_threshold_cents);
  const ownerApprovalRequired = caller.profile.role === "buyer" &&
    threshold !== null &&
    (threshold === 0 || orderValueCents > threshold);
  return {
    ...payload,
    account: store.organization,
    licenceNumber: store.license_number,
    location: store.display_name,
    lines: verifiedLines,
    lineCount: verifiedLines.length,
    orderValue: orderValueCents / 100,
    orderValueCents,
    approvalThresholdCents: threshold,
    ownerApprovalRequired,
    approvalState: ownerApprovalRequired
      ? "Awaiting store owner approval"
      : "Ordered",
    containsPreorder: preorderProductIds.length > 0,
    preorderProductIds,
    releaseHold: preorderProductIds.length > 0,
    caseQuantityEnforced: store.enforce_case_quantity === true,
    gatesAtSubmission:
      "Retailer readiness, store license, ordering status, store scope, published price, Canix availability after explicit reservations, optional case policy, release state, and owner-approval threshold verified server-side.",
  };
}

async function createDurableOrder(
  payload: Row,
  caller: { user: Row; profile: Row },
): Promise<Row> {
  const clientRequestId = String(payload.clientRequestId || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(clientRequestId)
  ) {
    throw new IntakeError(
      400,
      "The order is missing a valid idempotency identifier. Refresh the draft and try again.",
    );
  }
  const portalReference = String(
    payload.orderNumber || payload.portalReference || "",
  ).trim().slice(0, 160);
  if (!portalReference) {
    throw new IntakeError(400, "The order is missing its portal reference.");
  }
  const { data, error } = await service.rpc("portal_create_order", {
    p_client_request_id: clientRequestId,
    p_portal_reference: portalReference,
    p_organization: payload.account,
    p_location_license: payload.licenceNumber,
    p_location_name: payload.location,
    p_submitted_by: caller.profile.id,
    p_submitted_by_email: caller.user.email ?? null,
    p_submitted_by_role: caller.profile.role,
    p_state: payload.ownerApprovalRequired
      ? "awaiting_owner_approval"
      : "ordered",
    p_owner_approval_required: payload.ownerApprovalRequired === true,
    p_approval_threshold_cents: payload.approvalThresholdCents ?? null,
    p_order_value_cents: payload.orderValueCents,
    p_contains_preorder: payload.containsPreorder === true,
    p_release_hold: payload.releaseHold === true,
    p_delivery_window: payload.deliveryWindow ?? null,
    p_receiving_contact: payload.receivingContact ?? null,
    p_receiving_instructions: payload.receivingInstructions ?? null,
    p_lines: payload.lines,
    p_metadata: {
      summary: payload.summary,
      submittedVia: payload.submittedVia,
      approvalHeldBy: payload.approvalHeldBy,
      gatesAtSubmission: payload.gatesAtSubmission,
      caseQuantityEnforced: payload.caseQuantityEnforced === true,
    },
  });
  if (error) {
    const message = String(error.message || "");
    if (
      message.includes(
        "exceeds Canix availability after active portal commitments",
      )
    ) {
      throw new IntakeError(
        409,
        "A requested product is no longer available in the submitted quantity. The draft was preserved; reduce the quantity or contact Sales.",
      );
    }
    if (message.includes("No successful Canix snapshot")) {
      throw new IntakeError(
        503,
        "Canix availability is temporarily unavailable. The draft was preserved.",
      );
    }
    if (message.includes("require count-based Canix catalog items")) {
      throw new IntakeError(
        409,
        "Every live order line must use a current count-based Canix catalog item.",
      );
    }
    throw error;
  }
  return data as unknown as Row;
}

async function markDurableOrder(
  orderId: string,
  workflowState: string,
  options: Row = {},
): Promise<Row> {
  const { data, error } = await service.rpc("portal_mark_order_workflow", {
    p_order_id: orderId,
    p_workflow_state: workflowState,
    p_order_number: options.orderNumber ?? null,
    p_monday_item_id: options.mondayItemId ?? null,
    p_monday_board_id: options.mondayBoardId ?? null,
    p_error: options.error ?? null,
    p_metadata: options.metadata ?? {},
  });
  if (error) throw error;
  return data as unknown as Row;
}

async function existingDurableOrder(orderId: string): Promise<Row | null> {
  const { data, error } = await service.from("portal_order")
    .select(
      "id,portal_reference,order_number,state,workflow_state,owner_approval_required,approval_threshold_cents,contains_preorder,release_hold,order_value_cents",
    )
    .eq("id", orderId).maybeSingle();
  if (error) throw error;
  return data as unknown as Row | null;
}

function onboardingSubmissionType(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "new store" || normalized === "new_store") {
    return "new_store";
  }
  if (
    normalized === "existing store, people change" ||
    normalized === "people_change"
  ) return "people_change";
  if (
    normalized === "existing store, new location" ||
    normalized === "new_location"
  ) return "new_location";
  throw new IntakeError(400, "Choose a supported onboarding request type.");
}

async function createDurableOnboarding(
  payload: Row,
  caller: { user: Row; profile: Row } | null,
): Promise<Row> {
  const clientRequestId = String(payload.clientRequestId || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(clientRequestId)
  ) {
    throw new IntakeError(
      400,
      "The onboarding request is missing a valid idempotency identifier. Refresh and try again.",
    );
  }
  const owner = payload.owner && typeof payload.owner === "object" &&
      !Array.isArray(payload.owner)
    ? payload.owner as Row
    : {};
  const stores = Array.isArray(payload.locations)
    ? payload.locations as Row[]
    : [];
  const normalizedStores = stores.map((store) => ({
    name: String(store.name || "").trim().slice(0, 200),
    license: String(store.license || "").trim().toUpperCase().slice(0, 120),
    address: String(store.address || "").trim().slice(0, 500),
  }));
  const storeLicense = (location: unknown): string | null => {
    const target = String(location || "").trim().toLowerCase();
    if (!target) return null;
    const match = normalizedStores.find((store) =>
      store.license.toLowerCase() === target ||
      store.name.toLowerCase() === target
    );
    return match?.license ?? null;
  };
  const people: Row[] = [];
  if (String(owner.name || "").trim() || String(owner.email || "").trim()) {
    people.push({
      role: "owner",
      name: String(owner.name || "").trim().slice(0, 200),
      email: String(owner.email || "").trim().toLowerCase().slice(0, 320),
      phone: String(owner.phone || "").trim().slice(0, 80),
      storeLicense: null,
    });
  }
  const buyer = payload.buyer && typeof payload.buyer === "object" &&
      !Array.isArray(payload.buyer)
    ? payload.buyer as Row
    : null;
  if (
    buyer &&
    (String(buyer.name || "").trim() || String(buyer.email || "").trim())
  ) {
    people.push({
      role: "buyer",
      name: String(buyer.name || "").trim().slice(0, 200),
      email: String(buyer.email || "").trim().toLowerCase().slice(0, 320),
      phone: String(buyer.phone || "").trim().slice(0, 80),
      storeLicense: storeLicense(buyer.location),
    });
  }
  const budtenders = Array.isArray(payload.budtenders)
    ? payload.budtenders as Row[]
    : [];
  for (const budtender of budtenders) {
    if (
      !String(budtender.name || "").trim() &&
      !String(budtender.email || "").trim()
    ) continue;
    people.push({
      role: "budtender",
      name: String(budtender.name || "").trim().slice(0, 200),
      email: String(budtender.email || "").trim().toLowerCase().slice(0, 320),
      phone: String(budtender.phone || "").trim().slice(0, 80),
      storeLicense: storeLicense(budtender.location),
    });
  }
  const { data, error } = await service.rpc(
    "portal_create_onboarding_request",
    {
      p_client_request_id: clientRequestId,
      // Public intake never chooses authoritative account links. Internal staff
      // establish those after QuickBooks identity and license qualification.
      p_retailer_account_id: null,
      p_quickbooks_customer_id: null,
      p_submission_type: onboardingSubmissionType(payload.submissionType),
      p_legal_entity: String(payload.legalEntity || "").trim().slice(0, 300),
      p_dba: String(payload.dba || "").trim().slice(0, 300),
      p_submitted_by: caller?.profile.id ?? null,
      p_submitted_by_email: caller?.user.email ?? owner.email ?? null,
      p_owner: owner,
      p_stores: normalizedStores,
      p_people: people,
      p_metadata: {
        summary: String(payload.summary || "").slice(0, 500),
        submittedVia: "UX Store Portal",
        submittedByLabel: String(payload.submittedBy || "").slice(0, 300),
      },
    },
  );
  if (error) {
    const message = String(error.message || "");
    const safe = [
      "supported onboarding submission type",
      "between one and ten stores",
      "Legal entity is required",
      "Owner contact is required",
      "Every store requires",
      "cannot repeat a store license",
      "Every onboarding person requires",
      "idempotency identifier belongs to a different onboarding request",
    ].find((candidate) => message.includes(candidate));
    if (safe) throw new IntakeError(409, safe);
    throw error;
  }
  return data as unknown as Row;
}

async function markDurableOnboarding(
  requestId: string,
  workflowState: string,
  options: Row = {},
): Promise<Row> {
  const { data, error } = await service.rpc("portal_mark_onboarding_workflow", {
    p_request_id: requestId,
    p_workflow_state: workflowState,
    p_monday_item_id: options.mondayItemId ?? null,
    p_monday_board_id: options.mondayBoardId ?? null,
    p_error: options.error ?? null,
  });
  if (error) throw error;
  return data as unknown as Row;
}

async function existingDurableOnboarding(
  requestId: string,
): Promise<Row | null> {
  const { data, error } = await service.from("portal_onboarding_request")
    .select("id,stage,workflow_state,monday_item_id,monday_board_id")
    .eq("id", requestId).maybeSingle();
  if (error) throw error;
  return data as unknown as Row | null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  if (!MAKE_WEBHOOK_URL || !MAKE_INTAKE_SECRET) {
    return json(request, { error: "The order intake is not configured." }, 503);
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 3_000_000) {
    return json(request, { error: "Submission is too large." }, 413);
  }
  let durableOrderId: string | null = null;
  let durableOnboardingId: string | null = null;
  try {
    const body = await request.json() as Row;
    const kind = String(body.kind || "").trim();
    const payload = body.payload && typeof body.payload === "object" &&
        !Array.isArray(body.payload)
      ? body.payload as Row
      : null;
    if (!KINDS.has(kind) || !payload) {
      return json(
        request,
        { error: "Unsupported or incomplete submission." },
        400,
      );
    }
    const caller = await identity(request);
    if (!caller && kind !== "onboarding") {
      return json(request, { error: "Sign in is required." }, 401);
    }
    if (caller && !(await canSubmit(kind, caller.profile))) {
      return json(
        request,
        { error: "This role cannot submit that request." },
        403,
      );
    }

    const verifiedPayload = kind === "order" && caller
      ? await verifyOrder(payload, caller)
      : { ...payload };
    if (caller) {
      verifiedPayload.submittedBy = `${
        caller.profile.full_name || caller.user.email || caller.user.id
      } (${caller.profile.role})`;
      verifiedPayload.submittedById = caller.user.id;
      verifiedPayload.submittedByOrg = caller.profile.org;
    }
    if (kind === "order" && caller) {
      const durable = await createDurableOrder(verifiedPayload, caller);
      durableOrderId = String(durable.id || "");
      if (!durableOrderId) {
        throw new Error("The durable order record was not created.");
      }
      verifiedPayload.portalOrderId = durableOrderId;
      verifiedPayload.clientRequestId = String(
        verifiedPayload.clientRequestId || "",
      );
      if (durable.created === false) {
        const existing = await existingDurableOrder(durableOrderId);
        if (existing?.workflow_state === "accepted") {
          return json(request, {
            ok: true,
            idempotent: true,
            portalOrderId: existing.id,
            orderNumber: existing.order_number,
            state: existing.state,
            ownerApprovalRequired: existing.owner_approval_required,
            approvalThresholdCents: existing.approval_threshold_cents,
            containsPreorder: existing.contains_preorder,
            releaseHold: existing.release_hold,
            verifiedOrderValueCents: existing.order_value_cents,
          });
        }
        throw new IntakeError(
          409,
          "This order request already exists and needs reconciliation. It was not sent to Monday again.",
        );
      }
    }
    if (kind === "onboarding") {
      const durable = await createDurableOnboarding(verifiedPayload, caller);
      durableOnboardingId = String(durable.id || "");
      if (!durableOnboardingId) {
        throw new Error("The durable onboarding record was not created.");
      }
      verifiedPayload.portalOnboardingRequestId = durableOnboardingId;
      verifiedPayload.clientRequestId = String(
        verifiedPayload.clientRequestId || "",
      );
      if (durable.created === false) {
        const existing = await existingDurableOnboarding(durableOnboardingId);
        if (existing?.workflow_state === "accepted") {
          return json(request, {
            ok: true,
            idempotent: true,
            portalOnboardingRequestId: existing.id,
            stage: existing.stage,
            mondayItemId: existing.monday_item_id,
            mondayBoardId: existing.monday_board_id,
          });
        }
        throw new IntakeError(
          409,
          "This onboarding request already exists and needs reconciliation. It was not sent to Monday again.",
        );
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28_000);
    let response: Response;
    try {
      response = await fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          kind,
          secret: MAKE_INTAKE_SECRET,
          sentAt: new Date().toISOString(),
          source: "UX Store Portal",
          unauthenticated: !caller,
          payload: verifiedPayload,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let result: Row = {};
    try {
      result = text ? JSON.parse(text) as Row : {};
    } catch {
      result = {};
    }
    if (!response.ok) {
      const message = String(
        result.error || `The workflow returned ${response.status}.`,
      );
      if (durableOrderId) {
        await markDurableOrder(durableOrderId, "needs_reconciliation", {
          error: message,
        });
      }
      if (durableOnboardingId) {
        await markDurableOnboarding(
          durableOnboardingId,
          "needs_reconciliation",
          { error: message },
        );
      }
      return json(request, {
        error: message,
        reconciliationRequired: !!(durableOrderId || durableOnboardingId),
        portalOrderId: durableOrderId || null,
        portalOnboardingRequestId: durableOnboardingId || null,
      }, 502);
    }
    if (kind === "order" && !result.orderNumber && !result.id) {
      const message =
        "The order workflow accepted the request but did not return an order number.";
      if (durableOrderId) {
        await markDurableOrder(durableOrderId, "needs_reconciliation", {
          error: message,
        });
      }
      return json(request, {
        error: message,
        reconciliationRequired: !!durableOrderId,
        portalOrderId: durableOrderId || null,
      }, 502);
    }
    if (kind === "order" && durableOrderId) {
      await markDurableOrder(durableOrderId, "accepted", {
        orderNumber: result.orderNumber || result.id,
        mondayItemId: result.mondayItemId || result.itemId || result.id,
        mondayBoardId: result.mondayBoardId || result.boardId || null,
        metadata: {
          mondayAcceptedAt: new Date().toISOString(),
          mondayStatus: result.status || "accepted",
        },
      });
    }
    if (kind === "onboarding" && durableOnboardingId) {
      const mondayItemId = result.mondayItemId || result.itemId || result.id;
      if (!mondayItemId) {
        const message =
          "The onboarding workflow accepted the request but did not return a Monday item identifier.";
        await markDurableOnboarding(
          durableOnboardingId,
          "needs_reconciliation",
          { error: message },
        );
        return json(request, {
          error: message,
          reconciliationRequired: true,
          portalOnboardingRequestId: durableOnboardingId,
        }, 502);
      }
      await markDurableOnboarding(durableOnboardingId, "accepted", {
        mondayItemId,
        mondayBoardId: result.mondayBoardId || result.boardId || null,
      });
    }
    return json(request, {
      ok: true,
      ...result,
      portalOrderId: durableOrderId,
      portalOnboardingRequestId: durableOnboardingId,
      orderNumber: result.orderNumber || result.id || null,
      ownerApprovalRequired: kind === "order"
        ? verifiedPayload.ownerApprovalRequired
        : undefined,
      approvalThresholdCents: kind === "order"
        ? verifiedPayload.approvalThresholdCents
        : undefined,
      containsPreorder: kind === "order"
        ? verifiedPayload.containsPreorder
        : undefined,
      preorderProductIds: kind === "order"
        ? verifiedPayload.preorderProductIds
        : undefined,
      releaseHold: kind === "order" ? verifiedPayload.releaseHold : undefined,
      verifiedOrderValueCents: kind === "order"
        ? verifiedPayload.orderValueCents
        : undefined,
    });
  } catch (error) {
    const expected = error instanceof IntakeError;
    const timedOut = error instanceof Error && error.name === "AbortError";
    if (!expected && !timedOut) console.error("portal-intake", error);
    const message = timedOut
      ? "The portal workflow timed out."
      : expected
      ? error.message
      : "The portal intake is temporarily unavailable.";
    if (durableOrderId) {
      try {
        await markDurableOrder(durableOrderId, "needs_reconciliation", {
          error: message,
        });
      } catch { /* Keep the original error response. */ }
    }
    if (durableOnboardingId) {
      try {
        await markDurableOnboarding(
          durableOnboardingId,
          "needs_reconciliation",
          { error: message },
        );
      } catch { /* Keep the original error response. */ }
    }
    return json(request, {
      error: message,
      reconciliationRequired: !!(durableOrderId || durableOnboardingId),
      portalOrderId: durableOrderId || null,
      portalOnboardingRequestId: durableOnboardingId || null,
    }, error instanceof IntakeError ? error.status : 502);
  }
});
