import { DemoError, DEMO_CATALOG, DEMO_PRODUCTS, DEMO_SECTIONS, DEMO_STORES, initialDemoState, mutateDemo, projectDemo, demoRole, type DemoState, type DemoRole } from "../functions/_shared/store-demo.ts";
import snapshot from "../../data/canix-marketplace-listings-2026-10-14.json" with { type: "json" };
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }
const now = "2026-10-14T21:00:00.000Z", actor = "Internal Administrator Test";
const apply = (s: DemoState, role: DemoRole, body: Record<string, unknown>) => mutateDemo(s, role, body, actor, now);
function rejects(fn: () => unknown, status?: number) {
  try { fn(); } catch (e) { assert(e instanceof DemoError); if (status) assert(e.status === status, String(e)); return; }
  throw new Error("Expected denial");
}
function ready() {
  let s = initialDemoState();
  for (const section of DEMO_SECTIONS) {
    s = apply(s, "owner", { action: "submit-section", sectionId: section.id, values: s.sections[section.id].values });
    s = apply(s, "internal", { action: "review-section", sectionId: section.id, decision: "approved" });
  }
  return apply(s, "internal", { action: "finance-review", decision: "approved", terms: "Net 30", note: "Synthetic review" });
}
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
  for (const field of ["orders", "drafts", "finance", "invoices", "sections", "events"]) assert(!(field in body), field);
  const products = body.products as Record<string, unknown>[];
  assert(products.length === 120);
  for (const p of products) assert(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["brand", "category", "hasImage", "imageUrl", "name"]), JSON.stringify(Object.keys(p)));
  const serialized = JSON.stringify(body);
  for (const field of ["priceCents", "available", "minimumOrderQuantity", "saleUnit", "productGid", "productUrl", "syncRunId", "orderingReady"]) assert(!serialized.includes(field), field);
  rejects(() => apply(ready(), "budtender", order()), 403);
});
Deno.test("Buyer cannot receive a two-store accounting aggregate or internal Finance review notes", () => {
  const body = projectDemo(ready(), "buyer", 1);
  assert((body.invoices as unknown[]).length === 0);
  assert(!("terms" in (body.finance as Record<string, unknown>)) && !("note" in (body.finance as Record<string, unknown>)));
  assert(!("note" in (projectDemo(ready(), "owner", 1).finance as Record<string, unknown>)));
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
Deno.test("Finance pending, holds and due-date scenarios block without destroying drafts", () => {
  let s = ready();
  s = apply(s, "owner", { ...order(), action: "save-draft" });
  for (const decision of ["hold", "past_due"]) {
    const held = apply(s, "internal", { action: "finance-review", decision, terms: "Net 30", note: "Test hold" });
    rejects(() => apply(held, "owner", order()), 409);
    assert(Object.keys(held.drafts).length === 1);
  }
  rejects(() => apply(s, "owner", { action: "finance-review", decision: "approved", terms: "Net 30", note: "Self approve" }), 403);
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
  const reviewed = apply(s, "internal", { action: "finance-review", decision: "approved", terms: "Net 15", creditLimitCents: 5, note: "Terms only" });
  assert(reviewed.finance.creditLimitCents === 1 && reviewed.finance.terms === "Net 15");
  assert(!("creditLimitCents" in apply(ready(), "internal", { action: "finance-review", decision: "approved", terms: "Net 30", creditLimitCents: 5, note: "Terms only" }).finance));
  rejects(() => apply(ready(), "internal", { action: "finance-review", decision: "approved", terms: "", note: "Missing terms" }));
  rejects(() => apply(ready(), "internal", { action: "finance-review", decision: "approved", terms: "Net 30", note: "" }));
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
Deno.test("Unknown roles and actions fail closed", () => {
  for (const role of ["manager", "administrator", "", null]) rejects(() => demoRole(role));
  rejects(() => apply(ready(), "internal", { action: "send-email" }));
});
