// Approved Store account policy (checklist 2026-10-15). Pure rules only: no I/O,
// no connector writes and no delivery. The database migration
// 20261015120000_store_financial_hold_and_license_lifecycle.sql enforces the
// same rules at the write boundary; this module serves endpoints and the demo.
export const DEFAULT_PAYMENT_TERMS = "Net 30";
export const QUICKBOOKS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const LICENSE_REMINDER_LEAD_DAYS = 30;
// Temporary recipient. Prelaunch review must replace or explicitly reaffirm it;
// delivery stays off until notification release approval.
export const COMPLIANCE_REMINDER_CONFIG = Object.freeze({
  email: "tom@urbanxtracts.com",
  prelaunchReview: "replace_or_reaffirm_required" as const,
  deliveryEnabled: false as const,
  leadDays: LICENSE_REMINDER_LEAD_DAYS,
  channels: Object.freeze(["email", "in_portal"] as const),
});

// internalAdministrator must come from an active Internal administrator
// membership, not from the staff_role column alone.
export type InternalActor = { staffRole: string | null; departments: readonly string[]; internalAdministrator: boolean };
const departmentsOf = (actor: InternalActor | null | undefined) => Array.isArray(actor?.departments) ? actor!.departments : [];
const isAdministrator = (actor: InternalActor | null | undefined) => actor?.internalAdministrator === true && actor.staffRole === "administrator";

export function financialControlRole(actor: InternalActor | null | undefined): "administrator" | "finance" | null {
  if (isAdministrator(actor)) return "administrator";
  return departmentsOf(actor).includes("finance") ? "finance" : null;
}
// "quality" is the Quality and Compliance department.
export function licenseControlRole(actor: InternalActor | null | undefined): "administrator" | "finance" | "compliance" | null {
  const financial = financialControlRole(actor);
  if (financial) return financial;
  return departmentsOf(actor).includes("quality") ? "compliance" : null;
}

// One account-level override at most; locations always inherit it.
export function effectivePaymentTerms(accountOverride: string | null | undefined, globalDefault = DEFAULT_PAYMENT_TERMS) {
  const override = String(accountOverride ?? "").trim();
  return override ? { terms: override, source: "account_override" as const } : { terms: globalDefault, source: "global_default" as const };
}

export type Freshness = { state: "current" | "stale" | "unknown"; stale: boolean; lastSuccessfulSyncAt: string | null; ageMinutes: number | null; staleAfterHours: 24 };
// Stale from exactly 24 hours after the last successful sync. Unknown is also
// flagged stale for display, and never substitutes zero or blocks ordering.
export function quickBooksFreshness(lastSuccessfulAt: unknown, now: Date): Freshness {
  const text = typeof lastSuccessfulAt === "string" ? lastSuccessfulAt : "";
  const at = Date.parse(text), age = now.getTime() - at;
  if (!text || !Number.isFinite(at) || age < 0) return { state: "unknown", stale: true, lastSuccessfulSyncAt: null, ageMinutes: null, staleAfterHours: 24 };
  const stale = age >= QUICKBOOKS_STALE_AFTER_MS;
  return { state: stale ? "stale" : "current", stale, lastSuccessfulSyncAt: text, ageMinutes: Math.floor(age / 60_000), staleAfterHours: 24 };
}

// Approved field matrix. Buyers receive ordering information only; Budtenders nothing.
export function storeFinancialAccess(role: unknown) {
  const allowed = role === "owner" || role === "billing";
  return { invoices: allowed, balances: allowed, paymentHistory: allowed, terms: allowed };
}

export function financialOrderBlock(hold: { active?: boolean } | null | undefined) {
  return hold?.active === true
    ? { blocked: true, reason: "financial_hold" as const, message: "Ordering is on hold for this account. Your draft is preserved; contact urbanXtracts." }
    : { blocked: false, reason: null, message: "" };
}

const isoDate = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
};
const addDays = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);

// Valid through the verified expiration date; missing or invalid pauses.
export function licenseOrderPause(verifiedExpiresOn: unknown, today: string) {
  const expires = isoDate(verifiedExpiresOn);
  if (!expires) return { paused: true, reason: "license_unverified" as const };
  return expires < today ? { paused: true, reason: "license_expired" as const } : { paused: false, reason: null };
}

export type AccountingSignal = { overdueInvoice: boolean; balanceCents: number | null; freshness: Freshness["state"] };
// Independent gates. Accounting signals only ever produce warnings.
export function orderGates(input: { onboardingApproved: boolean; licenseVerifiedExpiresOn: unknown; today: string;
  financialHold: { active?: boolean } | null; accounting: AccountingSignal }) {
  const blocks: string[] = [], warnings: string[] = [];
  if (input.onboardingApproved !== true) blocks.push("onboarding_incomplete");
  const license = licenseOrderPause(input.licenseVerifiedExpiresOn, input.today);
  if (license.paused) blocks.push(license.reason!);
  if (financialOrderBlock(input.financialHold).blocked) blocks.push("financial_hold");
  if (input.accounting.overdueInvoice) warnings.push("invoice_overdue");
  if (typeof input.accounting.balanceCents === "number" && input.accounting.balanceCents !== 0) warnings.push("balance_outstanding");
  if (input.accounting.freshness !== "current") warnings.push("accounting_" + input.accounting.freshness);
  return { allowed: blocks.length === 0, blocks, warnings };
}

// Each recipient carries the destination identity it can actually be reached
// at: a portal profile for in-portal and Owner email (email resolved at send
// time), or a governed email address. The main contact is a fallback only when
// the account has no active Owner, and has no in-portal identity.
export type ReminderRecipient = { kind: "account_owner" | "main_contact" | "internal_compliance"; id: string; channels: readonly ("email" | "in_portal")[] };
export type ReminderIntent = { dedupeKey: string; licenseNumber: string; expiresOn: string; dueOn: string; recipientKind: ReminderRecipient["kind"];
  recipientId: string; channel: "email" | "in_portal"; deliveryState: "disabled_pending_release" };
const emailOf = (value: unknown) => {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
};
export function licenseReminderRecipients(input: { activeOwnerProfileIds: readonly string[]; mainContactEmail: string | null;
  compliance: { email: string | null; profileId: string | null } }): ReminderRecipient[] {
  const owners = [...new Set((input.activeOwnerProfileIds || []).filter(id => typeof id === "string" && id))];
  const recipients: ReminderRecipient[] = owners.map(id => ({ kind: "account_owner", id, channels: ["email", "in_portal"] }));
  const mainContact = emailOf(input.mainContactEmail);
  if (!owners.length && mainContact) recipients.push({ kind: "main_contact", id: mainContact, channels: ["email"] });
  const complianceEmail = emailOf(input.compliance?.email);
  if (complianceEmail) recipients.push({ kind: "internal_compliance", id: complianceEmail, channels: ["email"] });
  if (input.compliance?.profileId) recipients.push({ kind: "internal_compliance", id: input.compliance.profileId, channels: ["in_portal"] });
  return recipients;
}
// Due at T-30; a late run before expiration catches up. One intent per
// recipient identity, channel and license expiration; stored keys make retries no-ops.
export function planLicenseRenewalReminders(input: { licenseNumber: string; expiresOn: string; today: string;
  recipients: readonly ReminderRecipient[]; existingKeys: readonly string[] }): ReminderIntent[] {
  const expires = isoDate(input.expiresOn), today = isoDate(input.today);
  if (!expires || !today || !input.licenseNumber) return [];
  const dueOn = addDays(expires, -LICENSE_REMINDER_LEAD_DAYS);
  if (today < dueOn || today > expires) return [];
  const seen = new Set(input.existingKeys), intents: ReminderIntent[] = [];
  for (const recipient of input.recipients) {
    if (!recipient?.id || !["account_owner", "main_contact", "internal_compliance"].includes(recipient.kind)) continue;
    for (const channel of COMPLIANCE_REMINDER_CONFIG.channels) {
      if (!Array.isArray(recipient.channels) || !recipient.channels.includes(channel)) continue;
      const dedupeKey = ["license-renewal", input.licenseNumber, expires, recipient.kind, recipient.id, channel].join(":");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      intents.push({ dedupeKey, licenseNumber: input.licenseNumber, expiresOn: expires, dueOn, recipientKind: recipient.kind,
        recipientId: recipient.id, channel, deliveryState: "disabled_pending_release" });
    }
  }
  return intents;
}
// Send-time re-check against current authority. Nothing is sent before
// notification release; removed, replaced or superseded recipients never receive.
export function reminderSendDecision(intent: ReminderIntent, current: { deliveryReleased: boolean; activeOwnerProfileIds: readonly string[];
  mainContactEmail: string | null; complianceEmail: string | null; complianceProfileId: string | null }) {
  const owners = new Set(current.activeOwnerProfileIds || []);
  let reason: string | null = null;
  if (intent.recipientKind === "account_owner") reason = owners.has(intent.recipientId) ? null : "recipient_no_longer_authorized";
  else if (intent.recipientKind === "main_contact") reason = owners.size ? "superseded_by_account_owner"
    : emailOf(current.mainContactEmail) === intent.recipientId && intent.channel === "email" ? null : "recipient_no_longer_authorized";
  else reason = (intent.channel === "email" ? emailOf(current.complianceEmail) : current.complianceProfileId) === intent.recipientId ? null : "recipient_no_longer_authorized";
  if (reason) return { send: false, reason, recipientAuthorized: false };
  return current.deliveryReleased === true ? { send: true, reason: null, recipientAuthorized: true }
    : { send: false, reason: "delivery_disabled_pending_release", recipientAuthorized: true };
}

export type DocumentCaller =
  | { workspace: "internal"; actor: InternalActor }
  | { workspace: "store"; memberRole: string; retailerAccountId: string };
export function licenseDocumentAccess(caller: DocumentCaller, document: { retailerAccountId: string | null | undefined }): boolean {
  if (!document?.retailerAccountId) return false;
  if (caller?.workspace === "internal") return licenseControlRole(caller.actor) !== null;
  if (caller?.workspace === "store") return caller.memberRole === "store_owner" && caller.retailerAccountId === document.retailerAccountId;
  return false;
}
