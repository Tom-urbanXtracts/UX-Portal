import {
  COMPLIANCE_REMINDER_CONFIG, DEFAULT_PAYMENT_TERMS, DESIGNATED_MAIN_CONTACT_SOURCE, effectivePaymentTerms, financialControlRole, financialOrderBlock,
  licenseControlRole, licenseDocumentAccess, licenseOrderPause, licenseReminderRecipients, MISSING_ACCOUNT_RECIPIENT_ACTION, orderGates, planLicenseRenewalCycle, planLicenseRenewalReminders,
  planReminderRecipientException, quickBooksFreshness,
  reminderSendDecision, storeFinancialAccess, type InternalActor,
} from "../functions/_shared/store-account-policy.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }
const eq = (a: unknown, b: unknown, m = "") => assert(JSON.stringify(a) === JSON.stringify(b), m + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a));
const internal = (staffRole: string | null, departments: string[] = [], internalAdministrator = false): InternalActor => ({ staffRole, departments, internalAdministrator });
const ADMIN = internal("administrator", [], true), FINANCE = internal("operations", ["finance"]), COMPLIANCE = internal("quality", ["quality"]);
const SALES = internal("sales", ["sales"]), VIEWER = internal("viewer", []);

Deno.test("Global default terms are Net 30; one account override is inherited and no location value exists", () => {
  assert(DEFAULT_PAYMENT_TERMS === "Net 30");
  eq(effectivePaymentTerms(null), { terms: "Net 30", source: "global_default" });
  eq(effectivePaymentTerms("  "), { terms: "Net 30", source: "global_default" });
  eq(effectivePaymentTerms("Net 15"), { terms: "Net 15", source: "account_override" });
  // The function takes no location argument: every location resolves to the account result.
  assert(effectivePaymentTerms.length <= 2);
});
Deno.test("Only Finance and Internal portal Administrators control terms and financial holds", () => {
  assert(financialControlRole(ADMIN) === "administrator" && financialControlRole(FINANCE) === "finance");
  // An administrator staff role without an active Internal Administrator membership is not the portal Administrator.
  for (const actor of [COMPLIANCE, SALES, VIEWER, internal("administrator", [], false), internal(null, ["finance_forged"])]) assert(financialControlRole(actor) === null, JSON.stringify(actor));
  for (const forged of [null, undefined, {}, { staffRole: "administrator" }, { departments: "finance" }]) assert(financialControlRole(forged as unknown as InternalActor) === null);
});
Deno.test("Compliance, Finance or Internal Administrator verify licenses; Sales-only is denied", () => {
  assert(licenseControlRole(ADMIN) === "administrator" && licenseControlRole(FINANCE) === "finance" && licenseControlRole(COMPLIANCE) === "compliance");
  for (const actor of [SALES, VIEWER, internal("operations"), internal("administrator", [], false)]) assert(licenseControlRole(actor) === null);
});
Deno.test("QuickBooks becomes stale at exactly 24 hours after the last successful sync", () => {
  const last = "2026-10-14T12:00:00.000Z", at = (ms: number) => new Date(Date.parse(last) + ms);
  const current = quickBooksFreshness(last, at(24 * 3600_000 - 1000));
  assert(current.state === "current" && current.stale === false && current.lastSuccessfulSyncAt === last, "23:59:59 is current");
  assert(quickBooksFreshness(last, at(24 * 3600_000)).state === "stale", "24:00:00 is stale");
  assert(quickBooksFreshness(last, at(24 * 3600_000 + 1)).stale === true);
  for (const missing of [null, undefined, "", "not a date"]) {
    const unknown = quickBooksFreshness(missing, at(0));
    assert(unknown.state === "unknown" && unknown.stale === true && unknown.lastSuccessfulSyncAt === null && unknown.ageMinutes === null);
  }
  // A future timestamp is a clock fault, not freshness.
  assert(quickBooksFreshness("2026-10-15T12:00:00.000Z", at(0)).state === "unknown");
});
Deno.test("Financial matrix: Owner and billing user see own account; Buyer and Budtender see nothing", () => {
  for (const role of ["owner", "billing"]) eq(storeFinancialAccess(role), { invoices: true, balances: true, paymentHistory: true, terms: true }, role);
  for (const role of ["buyer", "budtender", "store_staff", "", "administrator", null]) eq(storeFinancialAccess(role), { invoices: false, balances: false, paymentHistory: false, terms: false }, String(role));
});
Deno.test("Only an explicit active manual hold blocks ordering for financial reasons", () => {
  assert(!financialOrderBlock(null).blocked && !financialOrderBlock({ active: false }).blocked);
  const held = financialOrderBlock({ active: true });
  assert(held.blocked && !/past due|balance|overdue/i.test(held.message));
  // Truthy non-boolean values never count as an audited hold.
  assert(!financialOrderBlock({ active: "true" } as unknown as { active: boolean }).blocked);
});
Deno.test("Overdue, nonzero balance and stale/unknown accounting are warnings only", () => {
  const base = { onboardingApproved: true, licenseVerifiedExpiresOn: "2030-12-31", today: "2026-10-15", financialHold: null };
  const result = orderGates({ ...base, accounting: { overdueInvoice: true, balanceCents: 120000, freshness: "stale" } });
  assert(result.allowed && result.blocks.length === 0);
  eq(result.warnings.sort(), ["accounting_stale", "balance_outstanding", "invoice_overdue"]);
  const unknown = orderGates({ ...base, accounting: { overdueInvoice: false, balanceCents: null, freshness: "unknown" } });
  assert(unknown.allowed && unknown.warnings.includes("accounting_unknown") && !unknown.warnings.includes("balance_outstanding"));
  const held = orderGates({ ...base, financialHold: { active: true }, accounting: { overdueInvoice: false, balanceCents: 0, freshness: "current" } });
  eq(held.blocks, ["financial_hold"]); assert(!held.allowed);
});
Deno.test("Expiration pauses ordering independently; only the verified expiration counts", () => {
  assert(licenseOrderPause(null, "2026-10-15").paused && licenseOrderPause("bad", "2026-10-15").paused && licenseOrderPause("2030-02-31", "2026-10-15").paused);
  assert(!licenseOrderPause("2026-10-15", "2026-10-15").paused, "valid through the expiration date");
  assert(licenseOrderPause("2026-10-14", "2026-10-15").paused);
  const gates = (hold: boolean, verified: string) => orderGates({ onboardingApproved: true, licenseVerifiedExpiresOn: verified, today: "2026-10-15",
    financialHold: { active: hold }, accounting: { overdueInvoice: false, balanceCents: 0, freshness: "current" } });
  eq(gates(false, "2026-10-14").blocks, ["license_expired"]);
  eq(gates(true, "2026-10-14").blocks.sort(), ["financial_hold", "license_expired"]);
  eq(gates(true, "2030-12-31").blocks, ["financial_hold"], "verified license does not clear a financial hold");
  eq(orderGates({ onboardingApproved: false, licenseVerifiedExpiresOn: "2030-12-31", today: "2026-10-15", financialHold: null,
    accounting: { overdueInvoice: false, balanceCents: 0, freshness: "current" } }).blocks, ["onboarding_incomplete"]);
});
Deno.test("T-30 reminder plans exactly one email and one in-portal intent per recipient, delivery disabled", () => {
  assert(COMPLIANCE_REMINDER_CONFIG.email === "tom@urbanxtracts.com" && COMPLIANCE_REMINDER_CONFIG.recipientReview === "reaffirmed" && COMPLIANCE_REMINDER_CONFIG.reviewedOn === "2026-10-15");
  assert(!("prelaunchReview" in COMPLIANCE_REMINDER_CONFIG), "the recipient is no longer awaiting replace-or-reaffirm review");
  assert(COMPLIANCE_REMINDER_CONFIG.deliveryEnabled === false && COMPLIANCE_REMINDER_CONFIG.leadDays === 30);
  const recipients = licenseReminderRecipients({ activeOwnerProfileIds: ["owner-1"], mainContactEmail: null,
    compliance: { email: COMPLIANCE_REMINDER_CONFIG.email, profileId: "compliance-profile" } });
  const plan = (today: string, existing: string[] = [], list = recipients) => planLicenseRenewalReminders({ licenseNumber: "OCM-1", expiresOn: "2026-11-14", today, recipients: list, existingKeys: existing });
  assert(plan("2026-10-14").length === 0, "T-31 plans nothing");
  const due = plan("2026-10-15");
  assert(due.length === 4 && new Set(due.map(i => i.dedupeKey)).size === 4);
  eq(due.map(i => i.recipientKind + ":" + i.channel).sort(), ["account_owner:email", "account_owner:in_portal", "internal_compliance:email", "internal_compliance:in_portal"]);
  assert(due.every(i => i.deliveryState === "disabled_pending_release" && i.dueOn === "2026-10-15"));
  // Retries and late catch-up runs deduplicate against stored keys and duplicated recipients.
  assert(plan("2026-10-16", due.map(i => i.dedupeKey)).length === 0);
  assert(plan("2026-10-15", [], [...recipients, recipients[0]]).length === 4);
  assert(plan("2026-11-14").length === 4 && plan("2026-11-15").length === 0, "no reminder after expiration");
  // A renewed expiration is a new reminder scope.
  const renewed = planLicenseRenewalReminders({ licenseNumber: "OCM-1", expiresOn: "2027-11-14", today: "2027-10-15", recipients, existingKeys: due.map(i => i.dedupeKey) });
  assert(renewed.length === 4);
});
Deno.test("Reminder recipients: Account Owners, main contact only without an active Owner, plus Internal Compliance", () => {
  const compliance = { email: "Compliance@Example.invalid", profileId: "compliance-profile" };
  const owners = licenseReminderRecipients({ activeOwnerProfileIds: ["owner-1", "owner-1", "owner-2"], mainContactEmail: "main@example.invalid", compliance });
  eq(owners.map(r => r.kind + ":" + r.id + ":" + r.channels.join("+")), ["account_owner:owner-1:email+in_portal", "account_owner:owner-2:email+in_portal",
    "internal_compliance:compliance@example.invalid:email", "internal_compliance:compliance-profile:in_portal"]);
  // No active Owner: the main contact receives email only (no portal identity), never in-portal.
  const fallback = licenseReminderRecipients({ activeOwnerProfileIds: [], mainContactEmail: " Main@Example.invalid ", compliance: { email: compliance.email, profileId: null } });
  eq(fallback.map(r => r.kind + ":" + r.id + ":" + r.channels.join("+")), ["main_contact:main@example.invalid:email", "internal_compliance:compliance@example.invalid:email"]);
  eq(licenseReminderRecipients({ activeOwnerProfileIds: [], mainContactEmail: "not-an-email", compliance: { email: "", profileId: null } }), []);
  // Each intent carries the exact authorized destination identity for its channel.
  const plan = planLicenseRenewalReminders({ licenseNumber: "OCM-1", expiresOn: "2026-11-14", today: "2026-10-15", recipients: fallback, existingKeys: [] });
  eq(plan.map(i => i.recipientKind + ":" + i.channel + ":" + i.recipientId), ["main_contact:email:main@example.invalid", "internal_compliance:email:compliance@example.invalid"]);
  // Send time: delivery is locked off; a superseded main contact or removed Owner is suppressed with a reason.
  const decide = (intent: typeof plan[number], current: Parameters<typeof reminderSendDecision>[1]) => reminderSendDecision(intent, current);
  const scope = { deliveryReleased: false, activeOwnerProfileIds: [] as string[], mainContactEmail: "main@example.invalid", complianceEmail: "compliance@example.invalid", complianceProfileId: null };
  eq(decide(plan[0], scope), { send: false, reason: "delivery_disabled_pending_release", recipientAuthorized: true });
  eq(decide(plan[0], { ...scope, activeOwnerProfileIds: ["owner-9"] }), { send: false, reason: "superseded_by_account_owner", recipientAuthorized: false });
  eq(decide(plan[1], { ...scope, complianceEmail: "replacement@example.invalid" }), { send: false, reason: "recipient_no_longer_authorized", recipientAuthorized: false });
  const ownerIntent = planLicenseRenewalReminders({ licenseNumber: "OCM-1", expiresOn: "2026-11-14", today: "2026-10-15", recipients: owners.slice(0, 1), existingKeys: [] })[0];
  eq(decide(ownerIntent, { ...scope, deliveryReleased: true, activeOwnerProfileIds: [] }), { send: false, reason: "recipient_no_longer_authorized", recipientAuthorized: false });
  eq(decide(ownerIntent, { ...scope, deliveryReleased: true, activeOwnerProfileIds: ["owner-1"] }), { send: true, reason: null, recipientAuthorized: true });
});
Deno.test("License documents: owning Account Owner plus Compliance, Finance and portal Administrator only", () => {
  const doc = { retailerAccountId: "acct-a" };
  assert(licenseDocumentAccess({ workspace: "store", memberRole: "store_owner", retailerAccountId: "acct-a" }, doc));
  for (const actor of [ADMIN, FINANCE, COMPLIANCE]) assert(licenseDocumentAccess({ workspace: "internal", actor }, doc));
  for (const memberRole of ["store_buyer", "store_staff", "billing", "store_billing"]) assert(!licenseDocumentAccess({ workspace: "store", memberRole, retailerAccountId: "acct-a" }, doc), memberRole);
  assert(!licenseDocumentAccess({ workspace: "store", memberRole: "store_owner", retailerAccountId: "acct-b" }, doc), "other account");
  for (const actor of [SALES, VIEWER]) assert(!licenseDocumentAccess({ workspace: "internal", actor }, doc));
  assert(!licenseDocumentAccess({ workspace: "store", memberRole: "store_owner", retailerAccountId: "acct-a" }, { retailerAccountId: "" }), "unattributed document");
  assert(!licenseDocumentAccess({ workspace: "brand" } as never, doc));
});
Deno.test("Missing Owner and missing designated main contact plan one deduplicated exception, never a guessed recipient", () => {
  assert(DESIGNATED_MAIN_CONTACT_SOURCE === "portal_retailer_account.account_owner_email");
  const base = { licenseNumber: "OCM-9", retailerAccountId: "acct-9", expiresOn: "2026-11-14", today: "2026-10-15", existingKeys: [] as string[] };
  const exception = planReminderRecipientException({ ...base, activeOwnerProfileIds: [], mainContactEmail: "not-an-email" })!;
  assert(exception && exception.kind === "missing_account_recipient" && exception.retailerAccountId === "acct-9" && exception.dueOn === "2026-10-15");
  assert(exception.dedupeKey === "license-renewal-exception:OCM-9:2026-11-14:missing_account_recipient" && exception.deliveryState === "disabled_pending_release");
  assert(exception.requiredAction === MISSING_ACCOUNT_RECIPIENT_ACTION && /Store Owner/.test(exception.requiredAction) && /no recipient was guessed/.test(exception.requiredAction));
  // Retries and late runs deduplicate; an Owner or a valid main contact means no exception.
  assert(planReminderRecipientException({ ...base, activeOwnerProfileIds: [], mainContactEmail: null, existingKeys: [exception.dedupeKey] }) === null);
  assert(planReminderRecipientException({ ...base, today: "2026-11-15", activeOwnerProfileIds: [], mainContactEmail: null }) === null, "after expiration");
  assert(planReminderRecipientException({ ...base, today: "2026-10-14", activeOwnerProfileIds: [], mainContactEmail: null }) === null, "before T-30");
  assert(planReminderRecipientException({ ...base, activeOwnerProfileIds: ["owner-1"], mainContactEmail: null }) === null);
  assert(planReminderRecipientException({ ...base, activeOwnerProfileIds: [], mainContactEmail: "main@example.invalid" }) === null);
});
Deno.test("Simulated T-30 run: Owner, designated main-contact fallback, missing-both exception; Compliance always planned; delivery off", () => {
  const compliance = { email: COMPLIANCE_REMINDER_CONFIG.email, profileId: null };
  const run = (accounts: { license: string; owners: string[]; main: string | null }[], existing: string[] = []) => accounts.map(a =>
    planLicenseRenewalCycle({ licenseNumber: a.license, retailerAccountId: "acct-" + a.license, expiresOn: "2026-11-14", today: "2026-10-15",
      activeOwnerProfileIds: a.owners, mainContactEmail: a.main, compliance, existingKeys: existing }));
  const accounts = [{ license: "OWN", owners: ["owner-1"], main: "main@example.invalid" }, { license: "MAIN", owners: [], main: "Main@Example.invalid" },
    { license: "NONE", owners: [], main: null }];
  const [owner, fallback, none] = run(accounts);
  const kinds = (cycle: typeof owner) => cycle.intents.map(i => i.recipientKind + ":" + i.channel + ":" + i.recipientId);
  assert(JSON.stringify(kinds(owner)) === JSON.stringify(["account_owner:email:owner-1", "account_owner:in_portal:owner-1", "internal_compliance:email:tom@urbanxtracts.com"]) && owner.exception === null);
  assert(JSON.stringify(kinds(fallback)) === JSON.stringify(["main_contact:email:main@example.invalid", "internal_compliance:email:tom@urbanxtracts.com"]) && fallback.exception === null);
  // No account recipient is guessed; Internal Compliance still receives its disabled intent and an exception is raised.
  assert(JSON.stringify(kinds(none)) === JSON.stringify(["internal_compliance:email:tom@urbanxtracts.com"]) && none.exception?.licenseNumber === "NONE");
  for (const cycle of [owner, fallback, none]) assert(cycle.deliveryEnabled === false && cycle.intents.every(i => i.deliveryState === "disabled_pending_release"));
  // A second run with stored keys plans nothing new and raises no duplicate exception.
  const stored = [owner, fallback, none].flatMap(c => [...c.intents.map(i => i.dedupeKey), ...(c.exception ? [c.exception.dedupeKey] : [])]);
  for (const cycle of run(accounts, stored)) assert(cycle.intents.length === 0 && cycle.exception === null);
  // Send time: still locked even for an authorized, released-looking request path.
  for (const intent of [...owner.intents, ...fallback.intents, ...none.intents]) {
    const decision = reminderSendDecision(intent, { deliveryReleased: false, activeOwnerProfileIds: intent.licenseNumber === "OWN" ? ["owner-1"] : [],
      mainContactEmail: intent.licenseNumber === "MAIN" ? "main@example.invalid" : null, complianceEmail: COMPLIANCE_REMINDER_CONFIG.email, complianceProfileId: null });
    assert(decision.send === false && decision.reason === "delivery_disabled_pending_release" && decision.recipientAuthorized === true, intent.dedupeKey);
  }
});
