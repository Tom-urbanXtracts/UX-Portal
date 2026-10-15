// Synthetic workflow only. This module deliberately has no connector or mail I/O.
// Products come from the checked-in browser-verified listing snapshot, not live inventory.
import { DEMO_CATALOG_PRODUCTS, DEMO_CATALOG_SOURCE } from "./store-demo-catalog.ts";
import { DEFAULT_PAYMENT_TERMS, effectivePaymentTerms, orderGates, quickBooksFreshness, storeFinancialAccess } from "./store-account-policy.ts";
// billing is the authorized billing user: read-only, own-account financials across every store of this one synthetic account.
export type DemoRole = "owner" | "buyer" | "billing" | "budtender" | "internal";
// The handler admits only active Internal Administrators, so the Internal view
// acts as an Internal portal Administrator for terms, holds and license decisions.
const DEMO_INTERNAL_ROLE = "administrator";
const DEMO_ACCOUNT = "urbanXtracts Store — Synthetic";
type Row = Record<string, unknown>;
export const DEMO_STORES = [
  { id: "DEMO-UX-STORE-001", name: "Demo Store #1" },
  { id: "DEMO-UX-STORE-002", name: "Demo Store #2" },
];
// The Marketplace Product ID is the only identity; names are display text and never a join key.
// The source has no SKU, pack/case size or release status, so none is carried here.
// brand is the canonical display brand; sourceBrand keeps the raw snapshot value.
export const DEMO_PRODUCTS = DEMO_CATALOG_PRODUCTS.map(p => ({
  id: p.marketplaceProductId, productGid: p.productGid, name: p.productName, brand: p.brandName, sourceBrand: p.sourceBrandName, category: p.itemCategoryName,
  priceCents: p.priceCents, availableQuantity: p.availableQuantity, saleUnit: p.saleUnit, minimumOrderQuantity: p.minimumOrderQuantity,
  hasImage: p.hasImage, imageUrl: p.imageUrl, productUrl: p.productUrl,
}));
const PRODUCT_BY_ID = new Map(DEMO_PRODUCTS.map(p => [p.id, p]));
export const DEMO_CATALOG = {
  ...DEMO_CATALOG_SOURCE,
  unavailableFields: ["sku", "packSize", "caseSize", "releaseStatus"],
  notice: "Browser-verified Shop UrbanXtracts listing snapshot captured " + DEMO_CATALOG_SOURCE.capturedAt.slice(0, 10)
    + ". Not live inventory; synthetic demo orders never reach Canix. SKU, pack/case size and release status are not in the source.",
};
export const DEMO_SECTIONS = [
  { id: "company", name: "Company Profile", fields: ["legalName", "dba"] },
  { id: "contacts", name: "Contacts & Authorized Users", fields: ["ownerName", "ownerEmail", "buyerEmail"] },
  { id: "billing", name: "Billing & Remittance", fields: ["billingEmail", "billingAddress"] },
  { id: "qualification", name: "Qualification Information", fields: ["businessType"] },
  { id: "license", name: "License & Operating Information", fields: ["locationName", "licenseReference", "expiration"] },
  { id: "documents", name: "Document Review", fields: ["attestation"] },
];
export type DemoState = {
  sections: Record<string, { status: string; values: Record<string, string>; note: string }>;
  // termsOverride is the single account-level override (null = global Net 30); there is no location value.
  // hold is the only financial order block and changes only by an audited Internal command.
  // accounting is synthetic QuickBooks evidence: warning-only, never a block.
  // creditLimitCents is legacy and inert: Stores have no credit cap. It is kept only so stored sessions round-trip.
  finance: { termsOverride: string | null; hold: { active: boolean; changedBy?: string; changedAt?: string; reason?: string };
    accounting: { invoiceState: "paid" | "overdue"; lastSuccessfulSyncAt: string | null }; creditLimitCents?: number };
  // Ordering uses only the verified expiration. An upload stays pending until verified.
  license: { verifiedExpiresOn: string | null; documentId: string | null;
    pendingRenewal: { documentId: string; expiresOn: string; uploadedBy: string; uploadedAt: string } | null };
  controlEvents: Row[]; // Append-only terms, hold, license and onboarding decisions.
  orders: Row[];
  drafts: Record<string, Row>;
  events: Row[];
};
export function initialDemoState(): DemoState {
  const example: Record<string, Record<string, string>> = {
    company: { legalName: "urbanXtracts Store — Synthetic", dba: "urbanXtracts Store" },
    contacts: { ownerName: "Demo Owner", ownerEmail: "owner@example.invalid", buyerEmail: "buyer@example.invalid" },
    billing: { billingEmail: "billing@example.invalid", billingAddress: "Synthetic demonstration address" },
    qualification: { businessType: "Retailer — synthetic demonstration" },
    license: { locationName: "Demo Store #1 & Demo Store #2", licenseReference: "DEMO ONLY — not an OCM license", expiration: "2030-12-31" },
    documents: { attestation: "Synthetic demonstration; no real documents uploaded" },
  };
  return {
    sections: Object.fromEntries(DEMO_SECTIONS.map(s => [s.id, { status: "draft", values: example[s.id], note: "" }])),
    finance: { termsOverride: null, hold: { active: false }, accounting: { invoiceState: "paid", lastSuccessfulSyncAt: null } },
    license: { verifiedExpiresOn: null, documentId: null, pendingRenewal: null },
    controlEvents: [], orders: [], drafts: {}, events: [],
  };
}
// Sessions saved before the 2026-10-15 policy carry finance.status. Only an
// explicit legacy "hold" stays a hold; "past_due" becomes a warning scenario.
export function normalizeDemoState(raw: unknown): DemoState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return initialDemoState();
  const state = structuredClone(raw) as DemoState & { finance: Row };
  const base = initialDemoState();
  const legacy = state.finance && typeof state.finance === "object" && "status" in state.finance ? state.finance : null;
  if (legacy) {
    const terms = String(legacy.terms || "").trim();
    state.finance = { termsOverride: terms && terms !== DEFAULT_PAYMENT_TERMS ? terms : null,
      hold: { active: legacy.status === "hold", ...(legacy.status === "hold" ? { reason: "Legacy demo hold", changedBy: String(legacy.reviewedBy || ""), changedAt: String(legacy.reviewedAt || "") } : {}) },
      accounting: { invoiceState: legacy.status === "past_due" ? "overdue" : "paid", lastSuccessfulSyncAt: null },
      ...(legacy.creditLimitCents === undefined ? {} : { creditLimitCents: Number(legacy.creditLimitCents) }) };
  } else if (!state.finance || typeof state.finance !== "object") state.finance = base.finance;
  if (!state.license || typeof state.license !== "object") {
    const section = state.sections?.license;
    state.license = { verifiedExpiresOn: section?.status === "approved" ? section.values?.expiration || null : null,
      documentId: section?.status === "approved" ? "DEMO-LICENSE-DOC-1" : null, pendingRenewal: null };
  }
  if (!Array.isArray(state.controlEvents)) state.controlEvents = [];
  for (const key of ["orders", "events"] as const) if (!Array.isArray(state[key])) state[key] = [];
  if (!state.drafts || typeof state.drafts !== "object") state.drafts = {};
  if (!state.sections || typeof state.sections !== "object") state.sections = base.sections;
  return state;
}
const validFutureDate = (value: string, now: string) => {
  const ms = Date.parse(value + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value && value > now.slice(0, 10);
};
function gatesFor(state: DemoState, now: string) {
  const freshness = quickBooksFreshness(state.finance.accounting.lastSuccessfulSyncAt, new Date(now));
  return { freshness, ...orderGates({ onboardingApproved: DEMO_SECTIONS.every(s => state.sections[s.id].status === "approved"),
    licenseVerifiedExpiresOn: state.license.verifiedExpiresOn, today: now.slice(0, 10), financialHold: state.finance.hold,
    accounting: { overdueInvoice: state.finance.accounting.invoiceState === "overdue",
      balanceCents: freshness.state === "unknown" ? null : state.finance.accounting.invoiceState === "overdue" ? 120000 : 0, freshness: freshness.state } }) };
}
const BLOCK_MESSAGES: Record<string, string> = {
  onboarding_incomplete: "Onboarding must be approved. Your draft is preserved.",
  license_expired: "The store license has expired; ordering is paused until a renewed license is verified. Your draft is preserved.",
  license_unverified: "The store license has not been verified; ordering is paused. Your draft is preserved.",
  financial_hold: "Ordering is on hold for this account. Your draft is preserved; contact urbanXtracts.",
};
// Buyers receive ordering information only, so the hold reason category is not disclosed to them.
const blockMessage = (block: string, role: DemoRole) => role === "buyer" && block === "financial_hold"
  ? "Ordering is on hold for this account. Your draft is preserved; contact your Account Owner." : BLOCK_MESSAGES[block];
// Every pause names its kind and a safe next step for the viewing role. A
// compliance pause (onboarding or license) is automatic; the financial hold is
// only ever the explicit manual one. No next step sends anything.
const PAUSE_KIND: Record<string, "compliance_pause" | "manual_financial_hold"> = {
  onboarding_incomplete: "compliance_pause", license_expired: "compliance_pause", license_unverified: "compliance_pause", financial_hold: "manual_financial_hold" };
const PAUSE_TITLE: Record<string, string> = { onboarding_incomplete: "Onboarding not yet approved", license_expired: "Store license expired",
  license_unverified: "Store license not verified", financial_hold: "Manual hold on this account" };
const PAUSE_SECTION: Record<string, string> = { onboarding_incomplete: "company", license_expired: "finance", license_unverified: "finance", financial_hold: "finance" };
const NEXT_STEPS: Record<string, Partial<Record<DemoRole, string>>> = {
  onboarding_incomplete: { owner: "Complete and submit each section under Company & Onboarding. urbanXtracts reviews it; nothing is sent.",
    buyer: "Ask your Account Owner to finish onboarding. Keep building this draft meanwhile.",
    internal: "Review the submitted sections under Company & Onboarding." },
  license_expired: { owner: "Record the renewed license under Account & License. Ordering resumes once Compliance verifies it.",
    buyer: "Ask your Account Owner to record the renewed license. Keep building this draft meanwhile.",
    internal: "Verify the recorded renewal with evidence under Account & License, or wait for the Owner to record it." },
  license_unverified: { owner: "Submit the license section, or record the renewed license under Account & License, for Compliance to verify.",
    buyer: "Ask your Account Owner to complete license verification. Keep building this draft meanwhile.",
    internal: "Verify the license with evidence under Company & Onboarding or Account & License." },
  financial_hold: { owner: "Contact your urbanXtracts representative to resolve the hold. This demo sends nothing.",
    buyer: "Contact your Account Owner. Keep building this draft meanwhile.",
    internal: "Release the manual hold with a reason and evidence under Account & License, if appropriate." },
};
// A Buyer learns only that the account is on hold, never that it is a financial one.
const pauseFor = (block: string, role: DemoRole) => {
  const masked = role === "buyer" && block === "financial_hold";
  return { code: masked ? "account_hold" : block, kind: masked ? "account_hold" : PAUSE_KIND[block],
    title: masked ? "Ordering on hold for this account" : PAUSE_TITLE[block], message: blockMessage(block, role),
    nextStep: NEXT_STEPS[block][role] || "", section: role === "buyer" ? null : PAUSE_SECTION[block], draftPreserved: true };
};
function requireControlText(body: Row) {
  const reason = String(body.reason || "").trim().slice(0, 1000), evidence = String(body.evidence || "").trim().slice(0, 1000);
  requireValue(reason && evidence, "Add a reason and evidence reference.");
  return { reason, evidence };
}
function appendControl(next: DemoState, event: Row, actor: string, now: string) {
  // Append-only: a reset never removes control events, so the sandbox audit has a fixed capacity.
  requireValue(next.controlEvents.length < 500, "This demo sandbox's control audit is full; no further control decisions can be recorded.", 409);
  next.controlEvents.push({ id: next.controlEvents.length + 1, ...event, actor, internalRole: DEMO_INTERNAL_ROLE, retailerAccount: DEMO_ACCOUNT, at: now });
}
export class DemoError extends Error { constructor(public status: number, message: string) { super(message); } }
function requireValue(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new DemoError(status, message);
}
export function demoRole(value: unknown): DemoRole {
  requireValue(["owner", "buyer", "billing", "budtender", "internal"].includes(String(value)), "Choose a supported demo view.");
  return value as DemoRole;
}
export function demoStoreAllowed(role: DemoRole, store: unknown): boolean {
  return DEMO_STORES.some(s => s.id === store) && (role === "owner" || role === "billing" || role === "internal" || store === DEMO_STORES[0].id);
}
function linesFor(raw: unknown, final: boolean): Row[] {
  requireValue(Array.isArray(raw) && raw.length <= 50 && (!final || raw.length > 0), "Add at least one product before submitting.");
  const seen = new Set();
  return raw.map(line => {
    requireValue(line && typeof line === "object", "Invalid product line.");
    const product = typeof line.productId === "string" ? PRODUCT_BY_ID.get(line.productId) : undefined;
    requireValue(product && !seen.has(product.id), "Choose each current demo product only once.");
    seen.add(product.id);
    const quantity = Number(line.quantity);
    requireValue(Number.isInteger(quantity) && quantity > 0, "Quantity must be a whole number.");
    // The source states a minimum, not a multiple: any whole quantity at or above it is accepted.
    requireValue(quantity >= product.minimumOrderQuantity, "Minimum order for " + product.name + " is " + product.minimumOrderQuantity + " " + product.saleUnit + ".");
    requireValue(quantity <= product.availableQuantity, "Quantity exceeds the snapshot's displayed availability.");
    return { productId: product.id, name: product.name, quantity, priceCents: product.priceCents, totalCents: quantity * product.priceCents };
  });
}
function allocatedByProduct(state: DemoState): Map<string, number> {
  const allocated = new Map<string, number>();
  for (const line of state.orders.filter(o => o.status !== "declined").flatMap(o => o.lines as Row[])) {
    allocated.set(String(line.productId), (allocated.get(String(line.productId)) || 0) + Number(line.quantity));
  }
  return allocated;
}
export function mutateDemo(state: DemoState, role: DemoRole, body: Row, actor: string, now: string): DemoState {
  const next = structuredClone(state);
  const action = String(body.action || "");
  requireValue(action !== "read", "Invalid mutation.");
  // The Billing view is read-only: no ordering, onboarding, license, control or reset command.
  requireValue(role !== "billing", "The Billing demo view is read-only.", 403);
  if (action === "reset") {
    requireValue(role === "internal", "Only the Internal demo view can reset the demonstration.", 403);
    // Mutable synthetic state resets; the append-only control audit is carried forward and records the reset.
    const fresh = initialDemoState();
    fresh.controlEvents = next.controlEvents;
    appendControl(fresh, { control: "demo_reset", prior: {}, next: {}, reason: "Reset of mutable synthetic demo state",
      evidence: "Administrator sandbox reset; control audit retained" }, actor, now);
    return fresh;
  }
  if (["save-section", "submit-section", "review-section"].includes(action)) {
    const spec = DEMO_SECTIONS.find(s => s.id === body.sectionId);
    requireValue(spec, "Unknown onboarding section.");
    const section = next.sections[spec.id];
    if (action === "review-section") {
      requireValue(role === "internal", "Internal review is required.", 403);
      requireValue(section.status === "submitted", "Only submitted sections can be reviewed.", 409);
      requireValue(["approved", "returned"].includes(String(body.decision)), "Choose Approve or Return.");
      const note = String(body.note || "").trim().slice(0, 1000);
      requireValue(body.decision !== "returned" || note, "Add a correction note.");
      requireValue(spec.id !== "license" || note, "Add license verification evidence.");
      const wasApproved = DEMO_SECTIONS.every(s => next.sections[s.id].status === "approved");
      section.status = String(body.decision); section.note = note;
      if (spec.id === "license") {
        const documentId = next.license.documentId || "DEMO-LICENSE-DOC-1";
        appendControl(next, { control: "license_verification", documentId, result: body.decision === "approved" ? "verified" : "returned",
          prior: { verifiedExpiresOn: next.license.verifiedExpiresOn }, next: { verifiedExpiresOn: body.decision === "approved" ? section.values.expiration : next.license.verifiedExpiresOn },
          reason: "Onboarding license review", evidence: note }, actor, now);
        if (body.decision === "approved") next.license = { ...next.license, verifiedExpiresOn: section.values.expiration, documentId };
      }
      if (!wasApproved && DEMO_SECTIONS.every(s => next.sections[s.id].status === "approved")) {
        appendControl(next, { control: "onboarding_approval", result: "approved", prior: { onboarding: "in_review" }, next: { onboarding: "approved" },
          reason: "All onboarding sections approved", evidence: "Section reviews: " + DEMO_SECTIONS.map(s => s.id).join(", ") }, actor, now);
      }
    } else {
      requireValue(role === "owner", "The Owner demo view completes the application.", 403);
      requireValue(["draft", "returned"].includes(section.status), "This section is locked for review.", 409);
      const values = body.values && typeof body.values === "object" ? body.values as Row : {};
      section.values = Object.fromEntries(spec.fields.map(f => [f, String(values[f] || "").trim().slice(0, 500)]));
      if (action === "submit-section") {
        requireValue(spec.fields.filter(f => !["dba", "buyerEmail"].includes(f)).every(f => section.values[f]), "Complete the required fields before submitting.");
        for (const key of spec.fields.filter(f => /Email$/.test(f))) {
          requireValue(!section.values[key] || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(section.values[key]), "Enter a valid email format; demo emails are never sent.");
        }
        if (spec.id === "license") {
          const expires = section.values.expiration, ms = Date.parse(expires + "T00:00:00Z");
          requireValue(/^\d{4}-\d{2}-\d{2}$/.test(expires) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === expires && expires > now.slice(0, 10), "Use a valid future demo expiration date.");
        }
        section.status = "submitted";
      }
    }
  } else if (["set-terms", "place-hold", "release-hold"].includes(action)) {
    // Finance or Internal portal Administrator only; the Store cannot set terms or its own hold.
    requireValue(role === "internal", "Finance or an Internal Administrator is required.", 403);
    const { reason, evidence } = requireControlText(body);
    if (action === "set-terms") {
      requireValue(body.storeId === undefined && body.locationId === undefined, "Payment terms apply to the whole retailer account; location overrides are not allowed.");
      const terms = String(body.terms || "").trim().slice(0, 80) || null;
      requireValue(terms !== next.finance.termsOverride, "Those payment terms are already in effect.", 409);
      const prior = effectivePaymentTerms(next.finance.termsOverride);
      next.finance.termsOverride = terms;
      appendControl(next, { control: "payment_terms", prior, next: effectivePaymentTerms(terms), reason, evidence }, actor, now);
    } else {
      const active = action === "place-hold";
      requireValue(next.finance.hold.active !== active, active ? "This account is already on hold." : "This account has no active hold.", 409);
      appendControl(next, { control: "financial_hold", prior: { active: !active }, next: { active }, reason, evidence }, actor, now);
      next.finance.hold = { active, changedBy: actor, changedAt: now, reason };
    }
  } else if (action === "simulate-accounting") {
    // Synthetic QuickBooks refresh. It changes warnings only and never touches a hold.
    requireValue(role === "internal", "Only the Internal demo view can simulate accounting data.", 403);
    const scenario = String(body.scenario);
    requireValue(["current", "overdue", "stale", "unknown"].includes(scenario), "Choose a supported accounting scenario.");
    const synced = scenario === "unknown" ? null : new Date(Date.parse(now) - (scenario === "stale" ? 24 * 3600_000 : 3600_000)).toISOString();
    next.finance.accounting = { invoiceState: scenario === "overdue" ? "overdue" : scenario === "current" ? "paid" : next.finance.accounting.invoiceState, lastSuccessfulSyncAt: synced };
  } else if (action === "upload-renewal") {
    requireValue(role === "owner", "The Account Owner uploads the renewed license.", 403);
    const expiresOn = String(body.expiration || "").trim();
    requireValue(validFutureDate(expiresOn, now), "Use a valid future renewal expiration date.");
    // Synthetic reference only: no file is accepted, stored or sent.
    next.license.pendingRenewal = { documentId: "DEMO-LICENSE-DOC-" + (next.controlEvents.length + next.events.length + 2), expiresOn, uploadedBy: actor, uploadedAt: now };
  } else if (action === "verify-license") {
    requireValue(role === "internal", "Compliance, Finance or an Internal Administrator must verify the license.", 403);
    requireValue(["verified", "rejected"].includes(String(body.decision)), "Choose Verify or Reject.");
    const evidence = String(body.evidence || "").trim().slice(0, 1000);
    requireValue(evidence, "Add license verification evidence.");
    const renewal = next.license.pendingRenewal;
    requireValue(renewal, "No renewed license is awaiting verification.", 409);
    requireValue(body.decision !== "verified" || validFutureDate(renewal.expiresOn, now), "The renewed expiration must be in the future.", 409);
    const verifiedExpiresOn = body.decision === "verified" ? renewal.expiresOn : next.license.verifiedExpiresOn;
    appendControl(next, { control: "license_verification", documentId: renewal.documentId, result: String(body.decision),
      prior: { verifiedExpiresOn: next.license.verifiedExpiresOn }, next: { verifiedExpiresOn }, reason: "License renewal review", evidence }, actor, now);
    next.license = { verifiedExpiresOn, documentId: body.decision === "verified" ? renewal.documentId : next.license.documentId, pendingRenewal: null };
  } else if (["save-draft", "submit-order"].includes(action)) {
    requireValue(role === "owner" || role === "buyer", "This demo view cannot place orders.", 403);
    requireValue(demoStoreAllowed(role, body.storeId), "That location is outside this demo view.", 403);
    const key = role + ":" + body.storeId;
    const lines = linesFor(body.lines, action === "submit-order");
    const requestId = String(body.requestId || "");
    requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId), "A draft identifier is required.");
    const totalCents = lines.reduce((n, l) => n + Number(l.totalCents), 0);
    if (action === "submit-order") {
      const previous = next.orders.find(o => o.requestId === requestId);
      if (previous) {
        requireValue(previous.role === role && previous.storeId === body.storeId && JSON.stringify(previous.lines) === JSON.stringify(lines), "This draft identifier has already been used for a different order.", 409);
        return next;
      }
      // Independent gates; overdue, balance and stale accounting are warnings and never block.
      const gates = gatesFor(next, now);
      requireValue(gates.allowed, blockMessage(gates.blocks[0], role), 409);
      const allocated = allocatedByProduct(next);
      for (const line of lines) {
        const product = PRODUCT_BY_ID.get(String(line.productId))!;
        requireValue((allocated.get(product.id) || 0) + Number(line.quantity) <= product.availableQuantity, "Demo inventory changed; reduce quantity. Your draft is preserved.", 409);
      }
      next.orders.unshift({ id: "DEMO-PO-" + String(next.orders.length + 1).padStart(4, "0"), requestId, role, storeId: body.storeId, lines, totalCents,
        status: role === "buyer" && totalCents > 50000 ? "awaiting_owner" : "ordered", createdAt: now, createdBy: actor });
      delete next.drafts[key];
    } else next.drafts[key] = { requestId, storeId: body.storeId, lines, savedAt: now };
  } else if (action === "transition-order") {
    const order = next.orders.find(o => o.id === body.orderId);
    requireValue(order && demoStoreAllowed(role, order.storeId), "Order not found in this view.", 404);
    const transition = String(body.decision);
    if (order.status === "awaiting_owner") {
      requireValue(role === "owner", "Only the Store Owner demo view can approve a Buyer order.", 403);
      requireValue(["ordered", "declined"].includes(transition), "Choose Approve or Decline.");
    } else {
      requireValue(role === "internal", "Internal processing is required.", 403);
      requireValue(({ ordered: "approved", approved: "shipped", shipped: "delivered" } as Record<string, string>)[String(order.status)] === transition, "That order transition is not allowed.", 409);
      requireValue(next.finance.hold.active !== true, "This account has an active manual hold.", 409);
      // New lines carry no release semantics (the source has none). Only sessions saved under the retired
      // fabricated fixtures can hold a pre-order line; keep those held rather than silently shipping them.
      if (transition === "shipped") requireValue(!(order.lines as Row[]).some(l => l.preorder === true), "Pre-order fulfillment is held until product release.", 409);
    }
    order.status = transition; order.reviewedBy = actor; order.updatedAt = now;
  } else throw new DemoError(400, "Unsupported demo action.");
  requireValue(next.orders.length <= 200, "Reset the demonstration before adding more orders.", 409);
  next.events.unshift({ action, actor, role, at: now, reference: String(body.orderId || body.sectionId || body.storeId || "") });
  next.events = next.events.slice(0, 100);
  return next;
}
export function projectDemo(state: DemoState, role: DemoRole, revision: number, now = new Date().toISOString()): Row {
  // Billing receives account financials only: no catalog, products, ordering, drafts or orders.
  const billing = role === "billing";
  const commercial = role !== "budtender" && !billing;
  const allowedOrders = commercial ? state.orders.filter(o => demoStoreAllowed(role, o.storeId)) : [];
  const allocated = allocatedByProduct(state);
  // Budtender receives product-education fields only: no price, availability, minimum or source identifiers.
  const products = billing ? [] : DEMO_PRODUCTS.map(p => {
    const education = { name: p.name, brand: p.brand, category: p.category, hasImage: p.hasImage, imageUrl: p.imageUrl };
    return commercial ? { id: p.id, ...education, productGid: p.productGid, productUrl: p.productUrl, priceCents: p.priceCents, saleUnit: p.saleUnit,
      minimumOrderQuantity: p.minimumOrderQuantity, snapshotAvailableQuantity: p.availableQuantity,
      available: Math.max(0, p.availableQuantity - (allocated.get(p.id) || 0)) } : education;
  });
  const catalog = billing ? null : commercial ? DEMO_CATALOG
    : { shopName: DEMO_CATALOG.shopName, sourceMode: DEMO_CATALOG.sourceMode, capturedAt: DEMO_CATALOG.capturedAt, productCount: DEMO_CATALOG.productCount,
      notice: "Browser-verified Shop UrbanXtracts listing snapshot captured " + DEMO_CATALOG.capturedAt.slice(0, 10) + ". Product education only." };
  const gates = gatesFor(state, now);
  // Owner, Billing and Internal see own-account finance; Buyer receives ordering information only.
  const financial = role === "internal" || storeFinancialAccess(role).invoices;
  const terms = effectivePaymentTerms(state.finance.termsOverride);
  const unknown = gates.freshness.state === "unknown";
  return { synthetic: true, organization: "urbanXtracts Store", revision, role, ...(billing ? { readOnly: true } : { catalog, products }),
    stores: DEMO_STORES.filter(s => demoStoreAllowed(role, s.id)),
    ...(commercial ? { orderingReady: gates.allowed, ordering: { allowed: gates.allowed, blocks: gates.blocks.map(b => blockMessage(b, role)),
      pauses: gates.blocks.map(b => pauseFor(b, role)) },
      orders: allowedOrders, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => key.startsWith(role + ":"))) } : {}),
    ...(financial ? {
      finance: { terms: terms.terms, termsSource: terms.source, warnings: gates.warnings,
        hold: role === "internal" ? state.finance.hold : { active: state.finance.hold.active === true },
        accounting: { state: gates.freshness.state, lastSuccessfulSyncAt: gates.freshness.lastSuccessfulSyncAt, ageMinutes: gates.freshness.ageMinutes, staleAfterHours: 24 } },
      // Unknown accounting is withheld rather than shown as a zero balance.
      invoices: unknown ? [] : [{ id: "DEMO-INV-001", amountCents: 120000, balanceCents: state.finance.accounting.invoiceState === "overdue" ? 120000 : 0,
        status: state.finance.accounting.invoiceState === "overdue" ? "Overdue" : "Paid", synthetic: true }],
      financialNotice: (unknown ? "No successful synthetic accounting sync is recorded; balances are withheld and not shown as zero. "
        : gates.freshness.stale ? "Synthetic accounting data is more than 24 hours old. " : "")
        + "Synthetic invoice — not a QuickBooks record. Overdue or outstanding balances are warnings and do not block ordering; only an explicit manual hold does.",
      license: role === "internal" ? state.license : { verifiedExpiresOn: state.license.verifiedExpiresOn, renewalAwaitingVerification: state.license.pendingRenewal !== null },
    } : {}),
    ...(["owner", "internal"].includes(role) ? { sections: DEMO_SECTIONS.map(s => ({ ...s, ...state.sections[s.id] })) } : {}),
    ...(role === "internal" ? { events: state.events, controlEvents: state.controlEvents } : {}),
  };
}
