// Synthetic fixtures only. This module deliberately has no connector or mail I/O.
export type DemoRole = "owner" | "buyer" | "budtender" | "internal";
type Row = Record<string, unknown>;
export const DEMO_STORES = [
  { id: "DEMO-UX-STORE-001", name: "Demo Store #1" },
  { id: "DEMO-UX-STORE-002", name: "Demo Store #2" },
];
export const DEMO_PRODUCTS = [
  { id: "demo-flower", name: "urbanXtracts Flower — Demo", brand: "urbanXtracts", category: "Flower", priceCents: 1800, caseUnits: 12, available: 240, released: true },
  { id: "demo-vape", name: "urbanXtracts Cartridge — Demo", brand: "urbanXtracts", category: "Vape", priceCents: 2200, caseUnits: 24, available: 360, released: true },
  { id: "demo-gummy", name: "Wana Mango Classic Gummies — Demo", brand: "Wana", category: "Edible", priceCents: 1400, caseUnits: 12, available: 180, released: true },
  { id: "demo-preroll", name: "urbanXtracts Pre-Roll — Demo", brand: "urbanXtracts", category: "Pre-Roll", priceCents: 800, caseUnits: 20, available: 100, released: false },
];
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
  finance: { status: string; terms: string; creditLimitCents: number; note: string; reviewedBy?: string; reviewedAt?: string };
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
    finance: { status: "pending", terms: "Net 30", creditLimitCents: 500000, note: "Finance review required" },
    orders: [], drafts: {}, events: [],
  };
}
export class DemoError extends Error { constructor(public status: number, message: string) { super(message); } }
function requireValue(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new DemoError(status, message);
}
export function demoRole(value: unknown): DemoRole {
  requireValue(["owner", "buyer", "budtender", "internal"].includes(String(value)), "Choose a supported demo view.");
  return value as DemoRole;
}
export function demoStoreAllowed(role: DemoRole, store: unknown): boolean {
  return DEMO_STORES.some(s => s.id === store) && (role === "owner" || role === "internal" || store === DEMO_STORES[0].id);
}
function linesFor(raw: unknown, final: boolean): Row[] {
  requireValue(Array.isArray(raw) && raw.length <= 50 && (!final || raw.length > 0), "Add at least one product before submitting.");
  const seen = new Set();
  return raw.map(line => {
    requireValue(line && typeof line === "object", "Invalid product line.");
    const product = DEMO_PRODUCTS.find(p => p.id === line.productId);
    requireValue(product && !seen.has(product.id), "Choose each current demo product only once.");
    seen.add(product.id);
    const quantity = Number(line.quantity);
    requireValue(Number.isInteger(quantity) && quantity > 0 && quantity <= product.available, "Quantity exceeds demo availability or is not a whole number.");
    return { productId: product.id, name: product.name, quantity, priceCents: product.priceCents,
      totalCents: quantity * product.priceCents, preorder: !product.released };
  });
}
export function mutateDemo(state: DemoState, role: DemoRole, body: Row, actor: string, now: string): DemoState {
  const next = structuredClone(state);
  const action = String(body.action || "");
  requireValue(action !== "read", "Invalid mutation.");
  if (action === "reset") {
    requireValue(role === "internal", "Only the Internal demo view can reset the demonstration.", 403);
    return initialDemoState();
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
      section.status = String(body.decision); section.note = note;
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
  } else if (action === "finance-review") {
    requireValue(role === "internal", "Internal Finance review is required.", 403);
    requireValue(["approved", "hold", "past_due"].includes(String(body.decision)), "Choose a Finance decision.");
    const credit = Number(body.creditLimitCents);
    const terms = String(body.terms || "").trim().slice(0, 80), note = String(body.note || "").trim().slice(0, 1000);
    requireValue(terms && note && Number.isSafeInteger(credit) && credit >= 0 && credit <= 100000000, "Add payment terms, a valid credit limit and a review note.");
    next.finance = { status: String(body.decision), terms, creditLimitCents: credit, note, reviewedBy: actor, reviewedAt: now };
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
      requireValue(DEMO_SECTIONS.every(s => next.sections[s.id].status === "approved"), "Onboarding must be approved. Your draft is preserved.", 409);
      requireValue(next.finance.status === "approved", "Finance has not cleared ordering. Your draft is preserved.", 409);
      const committed = next.orders.filter(o => !["declined", "delivered"].includes(String(o.status))).reduce((n, o) => n + Number(o.totalCents), 0);
      requireValue(committed + totalCents <= next.finance.creditLimitCents, "The demo credit limit would be exceeded. Your draft is preserved.", 409);
      for (const line of lines) {
        const product = DEMO_PRODUCTS.find(p => p.id === line.productId)!;
        const allocated = next.orders.filter(o => o.status !== "declined").flatMap(o => o.lines as Row[]).filter(l => l.productId === product.id).reduce((n, l) => n + Number(l.quantity), 0);
        requireValue(allocated + Number(line.quantity) <= product.available, "Demo inventory changed; reduce quantity. Your draft is preserved.", 409);
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
      requireValue(next.finance.status === "approved", "Finance has placed this account on hold.", 409);
      if (transition === "shipped") requireValue(!(order.lines as Row[]).some(l => l.preorder), "Pre-order fulfillment is held until product release.", 409);
    }
    order.status = transition; order.reviewedBy = actor; order.updatedAt = now;
  } else throw new DemoError(400, "Unsupported demo action.");
  requireValue(next.orders.length <= 200, "Reset the demonstration before adding more orders.", 409);
  next.events.unshift({ action, actor, role, at: now, reference: String(body.orderId || body.sectionId || body.storeId || "") });
  next.events = next.events.slice(0, 100);
  return next;
}
export function projectDemo(state: DemoState, role: DemoRole, revision: number): Row {
  const commercial = role !== "budtender";
  const allowedOrders = commercial ? state.orders.filter(o => demoStoreAllowed(role, o.storeId)) : [];
  const products = DEMO_PRODUCTS.filter(p => role !== "budtender" || p.released).map(p => {
    const base = { id: p.id, name: p.name, brand: p.brand, category: p.category, released: p.released };
    const allocated = state.orders.filter(o => o.status !== "declined").flatMap(o => o.lines as Row[]).filter(l => l.productId === p.id).reduce((n, l) => n + Number(l.quantity), 0);
    return commercial ? { ...base, priceCents: p.priceCents, caseUnits: p.caseUnits, available: Math.max(0, p.available - allocated) } : base;
  });
  return { synthetic: true, organization: "urbanXtracts Store", revision, role, products,
    stores: DEMO_STORES.filter(s => demoStoreAllowed(role, s.id)),
    ...(commercial ? { orderingReady: DEMO_SECTIONS.every(s => state.sections[s.id].status === "approved") && state.finance.status === "approved",
      orders: allowedOrders, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => key.startsWith(role + ":"))),
      finance: role === "internal" ? state.finance : role === "owner" ? { status: state.finance.status, terms: state.finance.terms, creditLimitCents: state.finance.creditLimitCents } : { status: state.finance.status },
      invoices: role === "buyer" ? [] : [{ id: "DEMO-INV-001", amountCents: 120000, balanceCents: state.finance.status === "past_due" ? 120000 : 0, status: state.finance.status === "past_due" ? "Past Due" : "Paid", synthetic: true }],
      financialNotice: role === "buyer" ? "Organization-wide statements are withheld: this Buyer is assigned to only one of two stores sharing an accounting account." : "Synthetic invoice — not a QuickBooks record." } : {}),
    ...(["owner", "internal"].includes(role) ? { sections: DEMO_SECTIONS.map(s => ({ ...s, ...state.sections[s.id] })) } : {}),
    ...(role === "internal" ? { events: state.events } : {}),
  };
}
