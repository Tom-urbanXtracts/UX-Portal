import { DemoError, DEMO_CATALOG, DEMO_PRODUCTS, DEMO_SECTIONS, DEMO_STORES, initialDemoState, mutateDemo, normalizeDemoState, projectDemo, demoRole, type DemoState, type DemoRole } from "../functions/_shared/store-demo.ts";
import snapshot from "../../data/canix-marketplace-listings-2026-10-14.json" with { type: "json" };
import invoiceProjection from "./fixtures/store_demo_invoice_projection.json" with { type: "json" };
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }
const now = "2026-10-14T21:00:00.000Z", actor = "Internal Administrator Test";
const apply = (s: DemoState, role: DemoRole, body: Record<string, unknown>, at = now) => mutateDemo(s, role, body, actor, at);
function rejects(fn: () => unknown, status?: number) {
  try { fn(); } catch (e) { assert(e instanceof DemoError); if (status) assert(e.status === status, String(e)); return; }
  throw new Error("Expected denial");
}
function ready() {
  let s = initialDemoState();
  for (const section of DEMO_SECTIONS) {
    s = apply(s, "owner", { action: "submit-section", sectionId: section.id, values: s.sections[section.id].values });
    s = apply(s, "internal", { action: "review-section", sectionId: section.id, decision: "approved", note: section.id === "license" ? "Synthetic license checked against demo record" : "" });
  }
  return s;
}
const control = { reason: "Synthetic control test", evidence: "DEMO-EVIDENCE-001" };
const hold = (s: DemoState) => apply(s, "internal", { action: "place-hold", ...control });
const release = (s: DemoState) => apply(s, "internal", { action: "release-hold", ...control });
const accounting = (s: DemoState, scenario: string, at = now) => apply(s, "internal", { action: "simulate-accounting", scenario }, at);
const finance = (s: DemoState, role: DemoRole, at = now) => projectDemo(s, role, 1, at).finance as Record<string, any>;
const orderAt = "2027-01-02T12:00:00.000Z"; // after the default synthetic license has been forced to expire below
// Authoritative Marketplace Product IDs from the snapshot, never names.
const BERRY_LEMONADE = "13057"; // $45.00, minimum 1, 297 displayed
const BERRY_KUSH = "18780"; // minimum 8
const WANA_MANGO = "10934"; // $13.00, minimum 1, 475 displayed
const product = (id: string) => DEMO_PRODUCTS.find(p => p.id === id)!;
const order = (quantity = 1, requestId = "00000000-0000-4000-8000-000000000001", storeId = DEMO_STORES[0].id, productId = BERRY_LEMONADE) => ({
  action: "submit-order", requestId, storeId, lines: [{ productId, quantity, priceCents: 1 }] });
Deno.test("Demo has two synthetic stores and contains no live package, accounting or service identifiers", () => {
  assert(DEMO_STORES.length === 2);
  assert(DEMO_STORES.every(s => s.id.startsWith("DEMO-")));
  const serialized = JSON.stringify(projectDemo(ready(), "owner", 1));
  for (const field of ["quickbooks_customer_id", "canix_package_id", "monday_item_id", "service_role", "bankAccount"]) assert(!serialized.includes(field));
});
Deno.test("Demo partial saves, submission lock, return and resubmission preserve evidence", () => {
  let s = initialDemoState();
  s = apply(s, "owner", { action: "save-section", sectionId: "company", values: { legalName: "Partial" } });
  assert(s.sections.company.values.legalName === "Partial" && s.sections.company.status === "draft");
  s = apply(s, "owner", { action: "submit-section", sectionId: "company", values: s.sections.company.values });
  rejects(() => apply(s, "owner", { action: "save-section", sectionId: "company", values: {} }), 409);
  rejects(() => apply(s, "buyer", { action: "review-section", sectionId: "company", decision: "approved" }), 403);
  rejects(() => apply(s, "internal", { action: "review-section", sectionId: "company", decision: "returned" }));
  s = apply(s, "internal", { action: "review-section", sectionId: "company", decision: "returned", note: "Confirm name" });
  s = apply(s, "owner", { action: "submit-section", sectionId: "company", values: { legalName: "Corrected" } });
  assert(s.sections.company.status === "submitted" && s.events.length === 4);
});
Deno.test("Demo validation denies incomplete applications, invalid emails and expired licenses", () => {
  const s = initialDemoState();
  rejects(() => apply(s, "owner", { action: "submit-section", sectionId: "contacts", values: {} }));
  rejects(() => apply(s, "owner", { action: "submit-section", sectionId: "contacts", values: { ownerName: "Owner", ownerEmail: "bad" } }));
  rejects(() => apply(s, "owner", { action: "submit-section", sectionId: "license", values: { ...s.sections.license.values, expiration: "2020-01-01" } }));
  for (const expiration of ["2030-02-31", "2030-99-99", "not a date"]) rejects(() => apply(s, "owner", { action: "submit-section", sectionId: "license", values: { ...s.sections.license.values, expiration } }));
});
Deno.test("Drafts save before qualification, reserve nothing and survive blocked submission", () => {
  const start = initialDemoState(), body = order(2);
  const s = apply(start, "buyer", { ...body, action: "save-draft" });
  assert(s.orders.length === 0 && Object.keys(s.drafts).length === 1);
  const projected = (projectDemo(s, "buyer", 1).products as Record<string, unknown>[]).find(p => p.id === BERRY_LEMONADE)!;
  assert(projected.available === product(BERRY_LEMONADE).availableQuantity && projected.snapshotAvailableQuantity === 297);
  rejects(() => apply(s, "buyer", body), 409);
  assert(Object.keys(s.drafts).length === 1);
});
Deno.test("Buyer is limited to location one; Owner can use both", () => {
  rejects(() => apply(ready(), "buyer", order(1, undefined, DEMO_STORES[1].id)), 403);
  assert(apply(ready(), "owner", order(1, undefined, DEMO_STORES[1].id)).orders.length === 1);
  assert((projectDemo(ready(), "buyer", 1).stores as unknown[]).length === 1);
});
Deno.test("Budtender projection omits every commercial and administration field", () => {
  const body = projectDemo(ready(), "budtender", 2);
  for (const field of ["orders", "drafts", "finance", "invoices", "sections", "events", "ordering", "license", "controlEvents", "financialNotice"]) assert(!(field in body), field);
  const products = body.products as Record<string, unknown>[];
  assert(products.length === 120);
  for (const p of products) assert(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["brand", "category", "hasImage", "imageUrl", "name"]), JSON.stringify(Object.keys(p)));
  const serialized = JSON.stringify(body);
  for (const field of ["priceCents", "available", "minimumOrderQuantity", "saleUnit", "productGid", "productUrl", "syncRunId", "orderingReady"]) assert(!serialized.includes(field), field);
  rejects(() => apply(ready(), "budtender", order()), 403);
});
Deno.test("Buyer receives ordering information only: no invoices, balances, terms or hold reasons", () => {
  const body = projectDemo(hold(accounting(ready(), "overdue")), "buyer", 1);
  for (const field of ["finance", "invoices", "controlEvents", "license"]) assert(!(field in body), field);
  const ordering = body.ordering as { allowed: boolean; blocks: string[] };
  assert(ordering.allowed === false && ordering.blocks.length === 1);
  const serialized = JSON.stringify(body);
  for (const text of ["balance", "Net 30", "terms", "Synthetic control test", "DEMO-EVIDENCE", "Overdue", "financial"]) assert(!serialized.toLowerCase().includes(text.toLowerCase()), text);
  // Owner sees own-account terms, hold state and warnings, but not internal reasons or evidence.
  const owner = projectDemo(hold(accounting(ready(), "overdue")), "owner", 1);
  const ownerFinance = owner.finance as Record<string, any>;
  assert(ownerFinance.terms === "Net 30" && ownerFinance.hold.active === true && !("reason" in ownerFinance.hold));
  assert(!JSON.stringify(owner).includes("DEMO-EVIDENCE") && !("controlEvents" in owner));
});
Deno.test("Overdue invoice, nonzero balance and stale or unknown accounting warn but never block", () => {
  for (const scenario of ["overdue", "stale", "unknown"]) {
    const s = accounting(ready(), scenario);
    const placed = apply(s, "owner", order());
    assert(placed.orders.length === 1 && placed.orders[0].status === "ordered", scenario);
    const view = projectDemo(placed, "owner", 1, now);
    assert((view.ordering as { allowed: boolean }).allowed === true && ((view.finance as Record<string, any>).warnings as string[]).length > 0, scenario);
    assert(placed.controlEvents.length === s.controlEvents.length && placed.finance.hold.active === false, "no hold created: " + scenario);
  }
  const overdue = finance(accounting(ready(), "overdue"), "owner");
  assert(overdue.warnings.includes("invoice_overdue") && overdue.warnings.includes("balance_outstanding"));
});
Deno.test("Synthetic QuickBooks freshness turns stale at exactly 24 hours; unknown is never zero", () => {
  const s = accounting(ready(), "current", "2026-10-14T01:00:00.000Z"); // records last success one hour earlier, at 00:00:00
  assert(s.finance.accounting.lastSuccessfulSyncAt === "2026-10-14T00:00:00.000Z");
  assert(finance(s, "owner", "2026-10-14T23:59:59.000Z").accounting.state === "current");
  assert(finance(s, "owner", "2026-10-15T00:00:00.000Z").accounting.state === "stale");
  const unknown = projectDemo(accounting(ready(), "unknown"), "owner", 1, now);
  assert((unknown.finance as Record<string, any>).accounting.state === "unknown" && (unknown.finance as Record<string, any>).accounting.lastSuccessfulSyncAt === null);
  assert((unknown.invoices as unknown[]).length === 0 && /not shown as zero/i.test(String(unknown.financialNotice)));
  assert(!JSON.stringify(unknown.invoices).includes("balanceCents"));
});
Deno.test("Demo prices come from the snapshot manifest; quantity and foreign item forgery fail", () => {
  const placed = apply(ready(), "owner", order(2)).orders[0];
  assert(placed.totalCents === 9000 && (placed.lines as Record<string, unknown>[])[0].priceCents === 4500, "client price ignored");
  assert(!("preorder" in (placed.lines as Record<string, unknown>[])[0]));
  for (const quantity of [0, -1, 1.5, 298, NaN]) rejects(() => apply(ready(), "owner", order(quantity)));
  rejects(() => apply(ready(), "owner", order(1, undefined, undefined, "live-canix-item")));
  rejects(() => apply(ready(), "owner", order(1, undefined, undefined, "demo-flower")));
  // Identity is the Marketplace Product ID string only: names, GIDs and numeric coercion are not accepted.
  rejects(() => apply(ready(), "owner", order(1, undefined, undefined, product(BERRY_LEMONADE).name)));
  rejects(() => apply(ready(), "owner", order(1, undefined, undefined, product(BERRY_LEMONADE).productGid)));
  rejects(() => apply(ready(), "owner", { ...order(), lines: [{ productId: 13057, quantity: 1 }] }));
});
Deno.test("Exact source minimum order quantity: below fails, minimum and non-multiples above pass", () => {
  assert(product(BERRY_KUSH).minimumOrderQuantity === 8);
  for (const action of ["save-draft", "submit-order"]) rejects(() => apply(ready(), "owner", { ...order(7, undefined, undefined, BERRY_KUSH), action }), 400);
  assert(apply(ready(), "owner", order(8, undefined, undefined, BERRY_KUSH)).orders[0].totalCents === 8 * 4500);
  assert(apply(ready(), "owner", order(9, undefined, undefined, BERRY_KUSH)).orders.length === 1, "minimum is not a multiple");
  rejects(() => apply(ready(), "owner", order(1331, undefined, undefined, BERRY_KUSH)), 400);
});
Deno.test("Draft-line save independently rejects a below-minimum line and leaves the saved draft unchanged", () => {
  const key = "owner:" + DEMO_STORES[0].id;
  const saved = apply(ready(), "owner", { ...order(9, undefined, undefined, BERRY_KUSH), action: "save-draft" });
  const before = JSON.stringify(saved);
  // A forged direct request: below-minimum line, client price and an extra valid line.
  for (const lines of [[{ productId: BERRY_KUSH, quantity: 7 }], [{ productId: BERRY_KUSH, quantity: 7, priceCents: 1 }, { productId: BERRY_LEMONADE, quantity: 1 }],
    [{ productId: BERRY_LEMONADE, quantity: 2 }, { productId: BERRY_KUSH, quantity: 1 }]]) {
    for (const role of ["owner", "buyer"] as DemoRole[]) {
      try {
        apply(saved, role, { action: "save-draft", requestId: "00000000-0000-4000-8000-000000000001", storeId: DEMO_STORES[0].id, lines });
        throw new Error("Expected minimum denial");
      } catch (e) {
        assert(e instanceof DemoError && e.status === 400 && e.message === "Minimum order for " + product(BERRY_KUSH).name + " is 8 each.", String(e));
      }
    }
  }
  assert(JSON.stringify(saved) === before, "rejection mutates neither the saved draft nor any other state");
  const savedLines = saved.drafts[key].lines as Record<string, number>[];
  assert(savedLines.length === 1 && savedLines[0].quantity === 9);
  // Exact minimum and a non-multiple above it save; the line carries the server price, not the client's.
  for (const quantity of [8, 13]) {
    const s = apply(saved, "owner", { action: "save-draft", requestId: "00000000-0000-4000-8000-000000000001", storeId: DEMO_STORES[0].id,
      lines: [{ productId: BERRY_KUSH, quantity, priceCents: 1 }] });
    const line = (s.drafts[key].lines as Record<string, number>[])[0];
    assert(line.quantity === quantity && line.totalCents === quantity * 4500, String(quantity));
  }
});
Deno.test("A stored below-minimum draft from before this guard stays visible and unaltered but is blocked at submission", () => {
  const key = "owner:" + DEMO_STORES[0].id, requestId = "00000000-0000-4000-8000-000000000009";
  const legacyLine = { productId: BERRY_KUSH, name: product(BERRY_KUSH).name, quantity: 7, priceCents: 4500, totalCents: 31500 };
  const stored = JSON.parse(JSON.stringify({ ...ready(), drafts: { [key]: { requestId, storeId: DEMO_STORES[0].id, lines: [legacyLine], savedAt: now } } }));
  const loaded = normalizeDemoState(stored);
  assert(JSON.stringify(loaded.drafts) === JSON.stringify(stored.drafts), "loading never rewrites stored draft data");
  const projected = projectDemo(loaded, "owner", 1) as Record<string, any>;
  assert(projected.drafts[key].lines[0].quantity === 7, "the invalid draft remains visible to its Owner");
  const before = JSON.stringify(loaded);
  try {
    apply(loaded, "owner", { action: "submit-order", requestId, storeId: DEMO_STORES[0].id, lines: [{ productId: BERRY_KUSH, quantity: 7 }] });
    throw new Error("Expected submission denial");
  } catch (e) {
    assert(e instanceof DemoError && e.status === 400 && e.message === "Minimum order for " + product(BERRY_KUSH).name + " is 8 each.", String(e));
  }
  assert(JSON.stringify(loaded) === before && loaded.orders.length === 0, "a blocked submission preserves the stored draft and creates no order");
});
Deno.test("Submission idempotency prevents duplicates and rejects changed payload reuse", () => {
  const s = apply(ready(), "owner", order(1));
  assert(apply(s, "owner", order(1)).orders.length === 1);
  rejects(() => apply(s, "owner", order(2)), 409);
});
Deno.test("Demo Buyer approval threshold applies only above $500 and cannot self or peer approve", () => {
  const s = apply(ready(), "buyer", order(28));
  assert(s.orders[0].status === "awaiting_owner");
  const body = { action: "transition-order", orderId: s.orders[0].id, decision: "ordered" };
  rejects(() => apply(s, "buyer", body), 403); rejects(() => apply(s, "internal", body), 403);
  assert(apply(s, "owner", body).orders[0].status === "ordered");
  assert(apply(ready(), "owner", order(28)).orders[0].status === "ordered");
  assert(apply(ready(), "buyer", order(11)).orders[0].status === "ordered", "$495.00 stays below the threshold");
});
Deno.test("Only an explicit audited manual hold blocks ordering; refresh never clears it", () => {
  let s = apply(ready(), "owner", { ...order(), action: "save-draft" });
  s = hold(s);
  for (const role of ["owner", "buyer"] as DemoRole[]) {
    try { apply(s, role, order()); throw new Error("Expected hold"); } catch (e) {
      assert(e instanceof DemoError && e.status === 409 && /on hold/.test(e.message) && !/past due|balance|overdue/i.test(e.message), String(e));
    }
  }
  assert(Object.keys(s.drafts).length === 1, "draft preserved");
  // Payment or accounting refresh never silently clears a manual hold.
  for (const scenario of ["current", "overdue", "stale", "unknown"]) {
    const refreshed = accounting(s, scenario);
    assert(refreshed.finance.hold.active === true, scenario);
    rejects(() => apply(refreshed, "owner", order()), 409);
  }
  const released = release(s);
  assert(released.finance.hold.active === false && apply(released, "owner", order()).orders.length === 1);
});
Deno.test("Each accepted hold or terms command appends exactly one complete audit event", () => {
  const s0 = ready(), s1 = hold(s0), s2 = release(s1);
  assert(s1.controlEvents.length === s0.controlEvents.length + 1 && s2.controlEvents.length === s1.controlEvents.length + 1);
  const event = s1.controlEvents.at(-1)!;
  for (const key of ["actor", "internalRole", "retailerAccount", "prior", "next", "reason", "evidence", "at"]) assert(event[key] !== undefined && event[key] !== "", key);
  assert(event.control === "financial_hold" && event.internalRole === "administrator" && event.actor === actor && event.at === now);
  assert((event.prior as Record<string, unknown>).active === false && (event.next as Record<string, unknown>).active === true);
  // Earlier entries are never rewritten.
  assert(JSON.stringify(s2.controlEvents.slice(0, s1.controlEvents.length)) === JSON.stringify(s1.controlEvents));
  // Rejected commands record nothing: no-op hold, missing reason or evidence.
  rejects(() => hold(s1), 409); rejects(() => release(s0), 409);
  rejects(() => apply(s0, "internal", { action: "place-hold", reason: "", evidence: "x" }));
  rejects(() => apply(s0, "internal", { action: "place-hold", reason: "x", evidence: " " }));
  const terms = apply(s0, "internal", { action: "set-terms", terms: "Net 15", ...control });
  const termsEvent = terms.controlEvents.at(-1)!;
  assert(termsEvent.control === "payment_terms" && (termsEvent.prior as Record<string, unknown>).terms === "Net 30" && (termsEvent.next as Record<string, unknown>).terms === "Net 15");
});
Deno.test("Store roles and forged roles cannot place or release holds, edit terms or simulate accounting", () => {
  const s = ready(), held = hold(s);
  for (const role of ["owner", "buyer", "billing", "budtender"] as DemoRole[]) {
    rejects(() => apply(s, role, { action: "place-hold", ...control }), 403);
    rejects(() => apply(held, role, { action: "release-hold", ...control }), 403);
    rejects(() => apply(s, role, { action: "set-terms", terms: "Net 60", ...control }), 403);
    rejects(() => apply(s, role, { action: "simulate-accounting", scenario: "current" }), 403);
  }
  for (const forged of ["administrator", "finance", "store_owner", "Internal"]) rejects(() => demoRole(forged));
  // Retired self-clearing Finance review is no longer an accepted command.
  rejects(() => apply(s, "internal", { action: "finance-review", decision: "approved", terms: "Net 30", note: "x" }), 400);
});
Deno.test("One account terms override applies to every location; no location-level override exists", () => {
  const s = apply(ready(), "internal", { action: "set-terms", terms: "Net 15", ...control });
  for (const role of ["owner", "internal"] as DemoRole[]) {
    const f = finance(s, role);
    assert(f.terms === "Net 15" && f.termsSource === "account_override" && !("locationTerms" in f), role);
  }
  rejects(() => apply(ready(), "internal", { action: "set-terms", terms: "Net 15", storeId: DEMO_STORES[1].id, ...control }), 400);
  const cleared = apply(s, "internal", { action: "set-terms", terms: "", ...control });
  assert(finance(cleared, "owner").terms === "Net 30" && finance(cleared, "owner").termsSource === "global_default");
  rejects(() => apply(cleared, "internal", { action: "set-terms", terms: "", ...control }), 409);
  assert(finance(ready(), "owner").terms === "Net 30");
});
Deno.test("License verification requires evidence and records the decision", () => {
  let s = initialDemoState();
  s = apply(s, "owner", { action: "submit-section", sectionId: "license", values: s.sections.license.values });
  rejects(() => apply(s, "internal", { action: "review-section", sectionId: "license", decision: "approved" }));
  rejects(() => apply(s, "owner", { action: "review-section", sectionId: "license", decision: "approved", note: "self" }), 403);
  const verified = apply(s, "internal", { action: "review-section", sectionId: "license", decision: "approved", note: "Checked" });
  const event = verified.controlEvents.at(-1)!;
  assert(event.control === "license_verification" && event.result === "verified" && event.documentId && event.evidence === "Checked" && event.internalRole === "administrator");
  assert(verified.license.verifiedExpiresOn === "2030-12-31");
  // Missing expiration cannot be submitted, so it can never reach approval.
  rejects(() => apply(initialDemoState(), "owner", { action: "submit-section", sectionId: "license", values: { locationName: "A", licenseReference: "B", expiration: "" } }));
  assert(ready().controlEvents.some(e => e.control === "onboarding_approval"));
});
Deno.test("Expiration pauses ordering; renewal upload stays paused until authorized verification", () => {
  const s = ready();
  // Clear accounting and no hold, yet an expired verified license pauses ordering.
  const expired = { ...s, license: { ...s.license, verifiedExpiresOn: "2026-12-31" } } as DemoState;
  rejects(() => apply(expired, "owner", order(), orderAt), 409);
  assert((projectDemo(expired, "owner", 1, orderAt).ordering as { blocks: string[] }).blocks.length === 1);
  rejects(() => apply(expired, "owner", { action: "upload-renewal", expiration: "2026-12-30" }, orderAt));
  rejects(() => apply(expired, "buyer", { action: "upload-renewal", expiration: "2027-12-31" }, orderAt), 403);
  const uploaded = apply(expired, "owner", { action: "upload-renewal", expiration: "2027-12-31" }, orderAt);
  assert(uploaded.license.pendingRenewal && uploaded.license.verifiedExpiresOn === "2026-12-31");
  rejects(() => apply(uploaded, "owner", order(), orderAt), 409);
  rejects(() => apply(uploaded, "owner", { action: "verify-license", decision: "verified", evidence: "self" }, orderAt), 403);
  rejects(() => apply(uploaded, "internal", { action: "verify-license", decision: "verified", evidence: "" }, orderAt));
  const rejected = apply(uploaded, "internal", { action: "verify-license", decision: "rejected", evidence: "Name mismatch" }, orderAt);
  rejects(() => apply(rejected, "owner", order(), orderAt), 409);
  const renewed = apply(uploaded, "internal", { action: "verify-license", decision: "verified", evidence: "Checked renewal" }, orderAt);
  assert(renewed.license.verifiedExpiresOn === "2027-12-31" && renewed.license.pendingRenewal === null);
  assert(apply(renewed, "owner", order(), orderAt).orders.length === 1);
  const verification = renewed.controlEvents.at(-1)!;
  assert(verification.control === "license_verification" && verification.result === "verified" && verification.documentId === uploaded.license.pendingRenewal!.documentId);
});
Deno.test("Compliance pause and financial hold are independent", () => {
  const s = hold(ready());
  const expired = { ...s, license: { ...s.license, verifiedExpiresOn: "2026-12-31" } } as DemoState;
  const uploaded = apply(expired, "owner", { action: "upload-renewal", expiration: "2027-12-31" }, orderAt);
  const renewed = apply(uploaded, "internal", { action: "verify-license", decision: "verified", evidence: "Checked renewal" }, orderAt);
  assert(renewed.finance.hold.active === true, "license verification does not clear a financial hold");
  assert(!renewed.controlEvents.slice(s.controlEvents.length).some(e => e.control === "financial_hold"));
  rejects(() => apply(renewed, "owner", order(), orderAt), 409);
  const releasedOnly = apply(expired, "internal", { action: "release-hold", ...control }, orderAt);
  assert(releasedOnly.license.verifiedExpiresOn === "2026-12-31");
  rejects(() => apply(releasedOnly, "owner", order(), orderAt), 409);
  assert(JSON.stringify((projectDemo(releasedOnly, "owner", 1, orderAt).ordering as { blocks: string[] }).blocks).includes("license"));
});
Deno.test("Legacy stored demo sessions normalize without inventing a hold", () => {
  const legacy = (status: string, terms = "Net 30") => normalizeDemoState({ ...structuredClone(ready()), finance: { status, terms, note: "old", creditLimitCents: 7 }, controlEvents: undefined, license: undefined } as unknown);
  const pastDue = legacy("past_due");
  assert(pastDue.finance.hold.active === false && pastDue.finance.accounting.invoiceState === "overdue" && pastDue.finance.creditLimitCents === 7);
  assert(legacy("hold").finance.hold.active === true, "an explicit legacy hold is retained");
  assert(legacy("approved", "Net 15").finance.termsOverride === "Net 15" && legacy("pending").finance.termsOverride === null);
  assert(pastDue.license.verifiedExpiresOn === "2030-12-31" && Array.isArray(pastDue.controlEvents));
  assert(normalizeDemoState(null).finance.hold.active === false);
});
Deno.test("Aggregate demo stock is checked across already submitted orders", () => {
  let s = apply(ready(), "owner", order(200));
  rejects(() => apply(s, "owner", order(98, "00000000-0000-4000-8000-000000000002", DEMO_STORES[1].id)), 409);
  s = apply(s, "owner", order(97, "00000000-0000-4000-8000-000000000002", DEMO_STORES[1].id));
  assert(s.orders.length === 2);
  assert((projectDemo(s, "owner", 1).products as Record<string, unknown>[]).find(p => p.id === BERRY_LEMONADE)!.available === 0);
});
Deno.test("No Store credit cap: committed totals never block, and legacy credit-limit data is inert", () => {
  let s = ready();
  assert(!("creditLimitCents" in initialDemoState().finance) && !("creditLimitCents" in s.finance));
  // A stored legacy cap far below the order value must not block submission.
  s.finance.creditLimitCents = 1;
  s = apply(s, "owner", order(297, "00000000-0000-4000-8000-000000000001", DEMO_STORES[0].id, BERRY_LEMONADE));
  s = apply(s, "owner", order(475, "00000000-0000-4000-8000-000000000002", DEMO_STORES[1].id, WANA_MANGO));
  assert(s.orders.length === 2 && s.orders.every(o => o.status === "ordered"));
  for (const role of ["owner", "buyer", "internal"] as DemoRole[]) assert(!JSON.stringify(projectDemo(s, role, 1)).includes("creditLimit"), role);
  // A submitted cap is ignored; a stored legacy value is preserved, not erased.
  const reviewed = apply(s, "internal", { action: "set-terms", terms: "Net 15", creditLimitCents: 5, ...control });
  assert(reviewed.finance.creditLimitCents === 1 && reviewed.finance.termsOverride === "Net 15");
  assert(!("creditLimitCents" in apply(ready(), "internal", { action: "set-terms", terms: "Net 15", creditLimitCents: 5, ...control }).finance));
  assert(!("creditLimitCents" in apply(ready(), "internal", { action: "place-hold", creditLimitCents: 5, ...control }).finance));
});
Deno.test("Order transitions cannot skip milestones; legacy stored pre-order lines stay held", () => {
  let s = apply(ready(), "owner", order());
  const id = s.orders[0].id;
  rejects(() => apply(s, "internal", { action: "transition-order", orderId: id, decision: "delivered" }), 409);
  for (const decision of ["approved", "shipped", "delivered"]) s = apply(s, "internal", { action: "transition-order", orderId: id, decision });
  assert(s.orders[0].status === "delivered" && s.orders[0].reviewedBy === actor);
  // Sessions saved under the retired fabricated fixtures may still hold pre-order lines.
  const legacy = ready();
  legacy.orders.unshift({ id: "DEMO-PO-0001", requestId: "00000000-0000-4000-8000-000000000009", role: "owner", storeId: DEMO_STORES[0].id, status: "approved",
    totalCents: 800, lines: [{ productId: "demo-preroll", name: "urbanXtracts Pre-Roll — Demo", quantity: 1, priceCents: 800, totalCents: 800, preorder: true }] });
  rejects(() => apply(legacy, "internal", { action: "transition-order", orderId: "DEMO-PO-0001", decision: "shipped" }), 409);
});
Deno.test("Catalog is the full verified snapshot keyed by Marketplace Product ID", () => {
  const source = snapshot.products;
  assert(DEMO_PRODUCTS.length === 120 && source.length === 120);
  assert(new Set(DEMO_PRODUCTS.map(p => p.id)).size === 120 && new Set(DEMO_PRODUCTS.map(p => p.productGid)).size === 120);
  assert(DEMO_PRODUCTS.filter(p => p.brand === "urbanXtracts").length === 35);
  // Raw "Cannaprints" displays as "Cannaprint"; the raw source brand is retained alongside.
  assert(new Set(DEMO_PRODUCTS.map(p => p.brand)).size === 13 && new Set(DEMO_PRODUCTS.map(p => p.sourceBrand)).size === 14);
  assert(new Set(source.map(row => row.brandName)).size === 14);
  const cannaprint = DEMO_PRODUCTS.filter(p => p.brand === "Cannaprint");
  assert(cannaprint.length === 6 && cannaprint.filter(p => p.sourceBrand === "Cannaprint").length === 4 && cannaprint.filter(p => p.sourceBrand === "Cannaprints").length === 2);
  assert(DEMO_PRODUCTS.every(p => p.brand === (p.sourceBrand === "Cannaprints" ? "Cannaprint" : p.sourceBrand)));
  for (const role of ["owner", "buyer", "budtender", "internal"] as DemoRole[]) {
    const products = projectDemo(ready(), role, 1).products as Record<string, unknown>[];
    assert(products.length === 120 && new Set(products.map(p => p.brand)).size === 13 && !products.some(p => p.brand === "Cannaprints"), role);
  }
  assert(new Set(DEMO_PRODUCTS.map(p => p.category)).size === 10);
  assert(DEMO_PRODUCTS.filter(p => p.hasImage && p.imageUrl).length === 98 && DEMO_PRODUCTS.filter(p => !p.hasImage && p.imageUrl === null).length === 22);
  for (const p of DEMO_PRODUCTS) {
    assert(Number.isInteger(p.priceCents) && p.priceCents > 0, p.id);
    assert(Number.isInteger(p.availableQuantity) && p.availableQuantity >= 0, p.id);
    assert(p.saleUnit === "each" && Number.isInteger(p.minimumOrderQuantity) && p.minimumOrderQuantity >= 1, p.id);
    // Every field matches the source record found by authoritative ID.
    const s = source.find(row => row.marketplaceProductId === p.id)!;
    assert(s && s.productGid === p.productGid && s.productName === p.name && s.brandName === p.sourceBrand && s.itemCategoryName === p.category
      && s.priceCents === p.priceCents && s.availableQuantity === p.availableQuantity && s.saleUnit === p.saleUnit
      && s.minimumOrderQuantity === p.minimumOrderQuantity && s.hasImage === p.hasImage && (s.imageUrl || null) === p.imageUrl && s.productUrl === p.productUrl, p.id);
  }
  // No SKU, pack/case size or release status is fabricated anywhere in the catalog or projections.
  for (const role of ["owner", "buyer", "budtender", "internal"] as DemoRole[]) {
    for (const p of projectDemo(ready(), role, 1).products as Record<string, unknown>[]) {
      for (const field of ["sku", "caseUnits", "packSize", "caseSize", "released", "releaseStatus", "preorder"]) assert(!(field in p), role + ":" + field);
    }
  }
  for (const p of DEMO_PRODUCTS) for (const field of ["sku", "caseUnits", "packSize", "released"]) assert(!(field in p), field);
});
Deno.test("Projection carries snapshot provenance and the unavailable-field notice", () => {
  const body = projectDemo(ready(), "owner", 1);
  const catalog = body.catalog as typeof DEMO_CATALOG;
  assert(catalog.sourceMode === "browser_verified_snapshot" && catalog.snapshotScope === "full_shop" && catalog.capturedAt === snapshot.source.capturedAt);
  assert(catalog.sourceFile === "data/canix-marketplace-listings-2026-10-14.json" && catalog.syncRunId === snapshot.source.syncRunId && catalog.productCount === 120);
  assert(["sku", "packSize", "caseSize", "releaseStatus"].every(f => catalog.unavailableFields.includes(f)));
  assert(/Not live inventory/.test(catalog.notice) && /2026-10-14/.test(catalog.notice));
  const budtender = projectDemo(ready(), "budtender", 1).catalog as Record<string, unknown>;
  assert(budtender.capturedAt === snapshot.source.capturedAt && !("syncRunId" in budtender) && !("sourceUrl" in budtender));
});
Deno.test("Reset is Internal-only and source state is immutable", () => {
  const s = ready(), copy = JSON.stringify(s);
  rejects(() => apply(s, "owner", { action: "reset" }), 403);
  assert(apply(s, "internal", { action: "reset" }).orders.length === 0);
  apply(s, "owner", order()); assert(JSON.stringify(s) === copy);
});
Deno.test("Reset restores mutable synthetic state but preserves the append-only control audit", () => {
  let s = hold(ready());
  s = apply(s, "internal", { action: "set-terms", terms: "Net 15", ...control });
  const audit = JSON.stringify(s.controlEvents);
  assert(s.controlEvents.length >= 4, "license, onboarding, hold and terms decisions recorded");
  const reset = apply(s, "internal", { action: "reset" });
  assert(JSON.stringify(reset.controlEvents.slice(0, s.controlEvents.length)) === audit, "earlier control events are unchanged");
  assert(reset.controlEvents.length === s.controlEvents.length + 1 && reset.controlEvents.at(-1)!.control === "demo_reset");
  // Mutable synthetic state is back to its initial values.
  const fresh = initialDemoState();
  for (const key of ["sections", "finance", "license", "orders", "drafts", "events"] as const) assert(JSON.stringify(reset[key]) === JSON.stringify(fresh[key]), key);
  // Control event IDs stay unique and monotonic across resets.
  const again = apply(hold(reset), "internal", { action: "reset" });
  const ids = again.controlEvents.map(e => Number(e.id));
  assert(ids.every((id, i) => i === 0 || id > ids[i - 1]) && new Set(ids).size === ids.length);
  assert(JSON.stringify((projectDemo(again, "internal", 1, now).controlEvents as unknown[]).slice(0, s.controlEvents.length)) === audit);
});
Deno.test("Unknown roles and actions fail closed", () => {
  for (const role of ["manager", "administrator", "", null]) rejects(() => demoRole(role));
  rejects(() => apply(ready(), "internal", { action: "send-email" }));
});
Deno.test("Billing view is accepted and projects own-account financials across every store with no catalog, ordering or onboarding", () => {
  assert(demoRole("billing") === "billing");
  const s = hold(apply(apply(accounting(ready(), "current"), "owner", { ...order(), action: "save-draft" }), "owner", order(1, "00000000-0000-4000-8000-000000000002", DEMO_STORES[1].id)));
  const body = projectDemo(s, "billing", 1, now);
  // Account-level grant: both synthetic stores of this one retailer account.
  assert(JSON.stringify(body.stores) === JSON.stringify(DEMO_STORES), "billing sees every store on the account");
  for (const key of ["catalog", "products", "ordering", "orderingReady", "orders", "drafts", "sections", "events", "controlEvents"]) assert(!(key in body), "billing must not receive " + key);
  const serialized = JSON.stringify(body);
  for (const leak of [BERRY_LEMONADE, WANA_MANGO, "productGid", "priceCents", "DEMO-PO-", "requestId", "Synthetic control test", "DEMO-EVIDENCE-001", "changedBy", "documentId", "pendingRenewal"]) assert(!serialized.includes(leak), "billing leak: " + leak);
  assert(body.readOnly === true && body.role === "billing");
  const f = finance(s, "billing");
  assert(f.terms === "Net 30" && f.termsSource === "global_default" && Array.isArray(f.warnings));
  // Manual-hold presence only, never the internal reason or evidence.
  assert(JSON.stringify(f.hold) === JSON.stringify({ active: true }));
  assert(Array.isArray(body.invoices) && (body.invoices as unknown[]).length === 1 && /not a QuickBooks record/.test(String(body.financialNotice)));
  const license = body.license as Record<string, unknown>;
  assert(JSON.stringify(Object.keys(license).sort()) === JSON.stringify(["renewalAwaitingVerification", "verifiedExpiresOn"]));
});
Deno.test("Billing sees stale and unknown accounting warnings and withheld balances, never a zero", () => {
  const stale = accounting(accounting(ready(), "overdue"), "stale");
  const f = finance(stale, "billing");
  assert(f.accounting.state === "stale" && f.warnings.includes("accounting_stale") && f.warnings.includes("invoice_overdue"));
  assert(/more than 24 hours old/.test(String(projectDemo(stale, "billing", 1, now).financialNotice)));
  const unknown = projectDemo(accounting(ready(), "unknown"), "billing", 1, now);
  assert((unknown.invoices as unknown[]).length === 0 && /withheld and not shown as zero/.test(String(unknown.financialNotice)));
  assert((unknown.finance as Record<string, any>).warnings.includes("accounting_unknown"));
});
Deno.test("Billing view is read-only: every mutation is denied and state is unchanged", () => {
  const base = ready(), held = hold(base);
  const withOrder = apply(base, "owner", order());
  const expired = { ...base, license: { ...base.license, pendingRenewal: { documentId: "DEMO-LICENSE-DOC-9", expiresOn: "2031-01-01", uploadedBy: actor, uploadedAt: now } } } as DemoState;
  const copy = JSON.stringify(withOrder);
  const attempts: [DemoState, Record<string, unknown>][] = [
    [base, { action: "reset" }],
    [base, { action: "save-section", sectionId: "billing", values: base.sections.billing.values }],
    [base, { action: "submit-section", sectionId: "billing", values: base.sections.billing.values }],
    [base, { action: "review-section", sectionId: "billing", decision: "approved", note: "x" }],
    [base, { action: "set-terms", terms: "Net 60", ...control }],
    [base, { action: "place-hold", ...control }],
    [held, { action: "release-hold", ...control }],
    [base, { action: "simulate-accounting", scenario: "current" }],
    [base, { action: "upload-renewal", expiration: "2031-01-01" }],
    [expired, { action: "verify-license", decision: "verified", evidence: "x" }],
    [base, { ...order(), action: "save-draft" }],
    [base, order()],
    [base, order(1, "00000000-0000-4000-8000-000000000003", DEMO_STORES[1].id)],
    [withOrder, { action: "transition-order", orderId: withOrder.orders[0].id, decision: "approved" }],
    [base, { action: "unknown-action" }],
  ];
  for (const [state, body] of attempts) rejects(() => apply(state, "billing", body), 403);
  assert(JSON.stringify(withOrder) === copy);
});
type Pause = { code: string; kind: string; title: string; message: string; nextStep: string; section: string | null; draftPreserved: boolean };
const pauses = (s: DemoState, role: DemoRole, at = now) => ((projectDemo(s, role, 1, at).ordering as { pauses: Pause[] }).pauses);
Deno.test("Every pause names its kind, explains the reason, preserves the draft and gives a role-safe next step", () => {
  // Fresh account: automatic compliance pauses only (onboarding and license), never a financial hold.
  const fresh = initialDemoState();
  for (const role of ["owner", "buyer", "internal"] as DemoRole[]) {
    const list = pauses(fresh, role);
    assert(JSON.stringify(list.map(p => p.code)) === JSON.stringify(["onboarding_incomplete", "license_unverified"]), role);
    assert(list.every(p => p.kind === "compliance_pause" && p.draftPreserved && /draft is preserved/i.test(p.message) && p.nextStep.length > 20 && p.title), role);
    assert(list.every(p => !/\b(sent|emailed|notified)\b/i.test(p.nextStep) || /nothing is sent|sends nothing/i.test(p.nextStep)), role);
  }
  // Owner and Internal see the manual hold as a distinct manual financial hold; overdue alone adds no pause.
  const held = hold(accounting(ready(), "overdue"));
  for (const role of ["owner", "internal"] as DemoRole[]) {
    const list = pauses(held, role);
    assert(list.length === 1 && list[0].code === "financial_hold" && list[0].kind === "manual_financial_hold" && list[0].section === "finance", role);
  }
  assert(pauses(accounting(ready(), "overdue"), "owner").length === 0 && pauses(accounting(ready(), "unknown"), "owner").length === 0, "warnings never pause");
  // Buyer learns only that the account is on hold, and is pointed to the Account Owner.
  const buyer = pauses(held, "buyer");
  assert(buyer.length === 1 && buyer[0].code === "account_hold" && buyer[0].kind === "account_hold" && buyer[0].section === null && /Account Owner/.test(buyer[0].nextStep));
  assert(!/financial|balance|overdue|terms/i.test(JSON.stringify(buyer)));
  // Both kinds at once stay distinct, and a verified renewal never clears the hold.
  const expired = { ...held, license: { ...held.license, verifiedExpiresOn: "2026-12-31" } } as DemoState;
  assert(JSON.stringify(pauses(expired, "owner", orderAt).map(p => p.kind).sort()) === JSON.stringify(["compliance_pause", "manual_financial_hold"]));
  // The blocked submit keeps the saved draft intact.
  const drafted = apply(expired, "owner", { ...order(), action: "save-draft" }, orderAt);
  rejects(() => apply(drafted, "owner", order(), orderAt), 409);
  assert(Object.keys(drafted.drafts).length === 1 && drafted.orders.length === 0);
});
Deno.test("Pause details never reach Billing or Budtender, and Billing has no license document or audit fields", () => {
  const s = hold(initialDemoState());
  for (const role of ["billing", "budtender"] as DemoRole[]) {
    const body = projectDemo(s, role, 1);
    assert(!("ordering" in body) && !JSON.stringify(body).includes("nextStep"), role);
  }
  const billing = JSON.stringify(projectDemo(s, "billing", 1));
  for (const leak of ["documentId", "pendingRenewal", "controlEvents", "events", "sections", "evidence"]) assert(!billing.includes(leak), leak);
});
Deno.test("Availability is checked against the snapshot and prior demo orders at submission", () => {
  const p = product(WANA_MANGO);
  rejects(() => apply(ready(), "owner", order(p.availableQuantity + 1, undefined, undefined, WANA_MANGO)), 400);
  const first = apply(ready(), "owner", order(p.availableQuantity - 1, undefined, undefined, WANA_MANGO));
  const remaining = (projectDemo(first, "owner", 1).products as Record<string, any>[]).find(x => x.id === WANA_MANGO)!;
  assert(remaining.available === 1 && remaining.snapshotAvailableQuantity === p.availableQuantity);
  rejects(() => apply(first, "owner", order(2, "00000000-0000-4000-8000-000000000009", undefined, WANA_MANGO)), 409);
});
Deno.test("Invoice projection fixture used by the Store Demo UI test matches the real projection, at most one invoice", () => {
  // Only the invoice-relevant subset: accounting state and invoices. Buyer and Budtender receive neither.
  const pick = (body: Record<string, unknown>) => ({
    ...("finance" in body ? { finance: { accounting: { state: (body.finance as Record<string, any>).accounting.state } } } : {}),
    ...("invoices" in body ? { invoices: body.invoices } : {}),
  });
  for (const role of ["owner", "billing", "internal", "buyer", "budtender"] as DemoRole[]) {
    for (const scenario of ["current", "overdue", "unknown"]) {
      const body = projectDemo(accounting(ready(), scenario), role, 1, now);
      const expected = (invoiceProjection as unknown as Record<string, Record<string, unknown>>)[role][scenario];
      assert(JSON.stringify(pick(body)) === JSON.stringify(expected), role + " " + scenario + ": " + JSON.stringify(pick(body)));
      // The UI renders a single invoice row; more than one would need a different template.
      assert(((body.invoices as unknown[] | undefined) || []).length <= 1, role + " " + scenario);
    }
  }
});
