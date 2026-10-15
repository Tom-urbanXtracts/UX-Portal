import { DemoError, DEMO_PRODUCTS, DEMO_SECTIONS, DEMO_STORES, initialDemoState, mutateDemo, projectDemo, demoRole, type DemoState, type DemoRole } from "../functions/_shared/store-demo.ts";
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
const order = (quantity = 1, requestId = "00000000-0000-4000-8000-000000000001", storeId = DEMO_STORES[0].id, productId = DEMO_PRODUCTS[0].id) => ({
  action: "submit-order", requestId, storeId, lines: [{ productId, quantity, priceCents: 1 }] });
Deno.test("Demo has two synthetic stores and contains no source-system identifiers", () => {
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
  assert((projectDemo(s, "buyer", 1).products as typeof DEMO_PRODUCTS)[0].available === DEMO_PRODUCTS[0].available);
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
  for (const p of body.products as Record<string, unknown>[]) for (const field of ["priceCents", "caseUnits", "available", "quantity"]) assert(!(field in p), field);
  rejects(() => apply(ready(), "budtender", order()), 403);
});
Deno.test("Buyer cannot receive a two-store accounting aggregate or internal Finance review notes", () => {
  const body = projectDemo(ready(), "buyer", 1);
  assert((body.invoices as unknown[]).length === 0);
  assert(!("terms" in (body.finance as Record<string, unknown>)) && !("note" in (body.finance as Record<string, unknown>)));
  assert(!("note" in (projectDemo(ready(), "owner", 1).finance as Record<string, unknown>)));
});
Deno.test("Demo prices come from fixtures; quantity and foreign item forgery fail", () => {
  assert(apply(ready(), "owner", order(2)).orders[0].totalCents === 3600);
  for (const quantity of [0, -1, 1.5, 241, NaN]) rejects(() => apply(ready(), "owner", order(quantity)));
  rejects(() => apply(ready(), "owner", order(1, undefined, undefined, "live-canix-item")));
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
  rejects(() => apply(s, "owner", order(41, "00000000-0000-4000-8000-000000000002")), 409);
  s = apply(s, "owner", order(40, "00000000-0000-4000-8000-000000000002"));
  assert(s.orders.length === 2);
});
Deno.test("No Store credit cap: committed totals never block, and legacy credit-limit data is inert", () => {
  let s = ready();
  assert(!("creditLimitCents" in initialDemoState().finance) && !("creditLimitCents" in s.finance));
  // A stored legacy cap far below the order value must not block submission.
  s.finance.creditLimitCents = 1;
  s = apply(s, "owner", order(240, "00000000-0000-4000-8000-000000000001", DEMO_STORES[0].id, DEMO_PRODUCTS[0].id));
  s = apply(s, "owner", order(360, "00000000-0000-4000-8000-000000000002", DEMO_STORES[1].id, DEMO_PRODUCTS[1].id));
  assert(s.orders.length === 2 && s.orders.every(o => o.status === "ordered"));
  for (const role of ["owner", "buyer", "internal"] as DemoRole[]) assert(!JSON.stringify(projectDemo(s, role, 1)).includes("creditLimit"), role);
  // A submitted cap is ignored; a stored legacy value is preserved, not erased.
  const reviewed = apply(s, "internal", { action: "finance-review", decision: "approved", terms: "Net 15", creditLimitCents: 5, note: "Terms only" });
  assert(reviewed.finance.creditLimitCents === 1 && reviewed.finance.terms === "Net 15");
  assert(!("creditLimitCents" in apply(ready(), "internal", { action: "finance-review", decision: "approved", terms: "Net 30", creditLimitCents: 5, note: "Terms only" }).finance));
  rejects(() => apply(ready(), "internal", { action: "finance-review", decision: "approved", terms: "", note: "Missing terms" }));
  rejects(() => apply(ready(), "internal", { action: "finance-review", decision: "approved", terms: "Net 30", note: "" }));
});
Deno.test("Order transitions cannot skip milestones and preorders cannot ship", () => {
  let s = apply(ready(), "owner", order());
  const id = s.orders[0].id;
  rejects(() => apply(s, "internal", { action: "transition-order", orderId: id, decision: "delivered" }), 409);
  for (const decision of ["approved", "shipped", "delivered"]) s = apply(s, "internal", { action: "transition-order", orderId: id, decision });
  assert(s.orders[0].status === "delivered" && s.orders[0].reviewedBy === actor);
  s = apply(ready(), "owner", order(1, undefined, undefined, "demo-preroll"));
  s = apply(s, "internal", { action: "transition-order", orderId: s.orders[0].id, decision: "approved" });
  rejects(() => apply(s, "internal", { action: "transition-order", orderId: s.orders[0].id, decision: "shipped" }), 409);
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
