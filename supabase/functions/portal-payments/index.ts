import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const PAYMENT_COLLECTION_ENABLED = Deno.env.get("PAYMENT_COLLECTION_ENABLED") === "true";
const PORTAL_URL = "https://portal.urbanxtracts.com";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; internal: boolean };
class PortalError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
    "https://portal.urbanxtracts.com",
    "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ]).has(candidate) ? candidate : "https://portal.urbanxtracts.com";
}
function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "authorization, apikey, content-type, stripe-signature",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}
function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    ...cors(request), "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
  } });
}
function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}
function cents(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenHasAal2(authorization)) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false) return null;
  if (profile.role === "internal") {
    const { data: grant } = await service.from("portal_role_permission").select("permission")
      .eq("staff_role", profile.staff_role).eq("permission", "financials.read").maybeSingle();
    if (!grant) throw new PortalError(403, "Financial access is not included in this workforce preset.");
    return { user, profile: profile as Row, internal: true };
  }
  if (!new Set(["owner", "buyer"]).has(String(profile.role))) {
    throw new PortalError(403, "Payment collection is available to Store Owners and Buyers.");
  }
  return { user, profile: profile as Row, internal: false };
}

async function assertCustomerAccess(caller: Caller, customerId: string): Promise<{ organization: string; license: string | null; storeName: string }> {
  if (caller.internal) throw new PortalError(403, "Internal users may send invoice notices but cannot initiate a retailer payment.");
  const { data: stores, error } = await service.from("portal_store").select(
    "license_number,organization,display_name,active,closed_at,quickbooks_customer_id",
  ).eq("quickbooks_customer_id", customerId).eq("organization", caller.profile.org).eq("active", true);
  if (error) throw error;
  const { data: account } = await service.from("portal_retailer_account").select(
    "organization_name,display_name,quickbooks_customer_id",
  ).eq("quickbooks_customer_id", customerId).eq("organization_name", caller.profile.org).maybeSingle();
  if (caller.profile.role === "owner") {
    if (stores?.length === 1) return { organization: String(caller.profile.org), license: String(stores[0].license_number), storeName: String(stores[0].display_name) };
    if (account) return { organization: String(caller.profile.org), license: null, storeName: String(account.display_name || caller.profile.org) };
    throw new PortalError(403, "That invoice is outside your organization.");
  }
  if (!stores?.length) throw new PortalError(403, "Buyers may pay only invoices mapped directly to an assigned store.");
  const { data: assignments, error: assignmentError } = await service.from("portal_profile_store").select("license_number")
    .eq("profile_id", caller.profile.id).in("license_number", stores.map((store) => store.license_number));
  if (assignmentError) throw assignmentError;
  if (!assignments?.length || stores.length !== 1) {
    throw new PortalError(403, "This invoice is not uniquely mapped to one of your assigned stores.");
  }
  return { organization: String(caller.profile.org), license: String(stores[0].license_number), storeName: String(stores[0].display_name) };
}

async function latestInvoice(invoiceId: string): Promise<Row> {
  const { data: sync, error: syncError } = await service.from("quickbooks_sync_state")
    .select("last_financial_run_id,connection_environment").eq("id", 1).maybeSingle();
  if (syncError) throw syncError;
  if (!sync?.last_financial_run_id || sync.connection_environment !== "production") {
    throw new PortalError(409, "A current production QuickBooks snapshot is required before payment.");
  }
  const { data, error } = await service.from("quickbooks_invoice_cache").select("*")
    .eq("sync_run_id", sync.last_financial_run_id).eq("quickbooks_invoice_id", invoiceId).maybeSingle();
  if (error) throw error;
  if (!data || Number(data.balance || 0) <= 0) throw new PortalError(409, "Choose an open invoice from the latest QuickBooks snapshot.");
  return data as Row;
}

async function createCheckout(caller: Caller, body: Row): Promise<Row> {
  if (!PAYMENT_COLLECTION_ENABLED || !STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    throw new PortalError(503, "Secure online payment is not enabled yet. Invoice display remains available.");
  }
  const invoiceId = clean(body.invoiceId, 120);
  if (!invoiceId) throw new PortalError(400, "Choose an invoice.");
  const invoice = await latestInvoice(invoiceId);
  const scope = await assertCustomerAccess(caller, String(invoice.quickbooks_customer_id));
  const amountCents = cents(invoice.balance);
  if (amountCents < 50) throw new PortalError(409, "The open balance is too small for online payment.");
  const { data: existing } = await service.from("portal_payment_attempt").select("*")
    .eq("quickbooks_invoice_id", invoiceId).in("state", ["creating", "open"]).maybeSingle();
  if (existing?.provider_checkout_url) {
    return { attemptId: existing.id, checkoutUrl: existing.provider_checkout_url, state: existing.state, reused: true };
  }
  const { data: attempt, error } = await service.from("portal_payment_attempt").insert({
    quickbooks_invoice_id: invoiceId,
    quickbooks_customer_id: invoice.quickbooks_customer_id,
    organization: scope.organization,
    store_license: scope.license,
    invoice_number: invoice.doc_number || invoiceId,
    amount_cents: amountCents,
    currency: String(invoice.currency || "USD").toUpperCase(),
    state: "creating",
    initiated_by: caller.profile.id,
    initiated_by_email: caller.user.email || null,
  }).select("*").single();
  if (error) throw error;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("client_reference_id", String(attempt.id));
  form.set("customer_email", String(caller.user.email || ""));
  form.set("success_url", `${PORTAL_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${PORTAL_URL}/?payment=cancelled`);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", String(invoice.currency || "USD").toLowerCase());
  form.set("line_items[0][price_data][unit_amount]", String(amountCents));
  form.set("line_items[0][price_data][product_data][name]", `urbanXtracts invoice ${invoice.doc_number || invoiceId}`);
  form.set("metadata[portal_payment_attempt_id]", String(attempt.id));
  form.set("metadata[quickbooks_invoice_id]", invoiceId);
  form.set("payment_intent_data[metadata][portal_payment_attempt_id]", String(attempt.id));
  form.set("payment_intent_data[metadata][quickbooks_invoice_id]", invoiceId);
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": String(attempt.id),
    },
    body: form,
  });
  const session = await response.json().catch(() => ({})) as Row;
  if (!response.ok || !session.id || !session.url) {
    await service.from("portal_payment_attempt").update({ state: "failed", updated_at: new Date().toISOString() })
      .eq("id", attempt.id);
    throw new PortalError(502, "The secure payment provider did not create a checkout session.");
  }
  const { data: updated, error: updateError } = await service.from("portal_payment_attempt").update({
    provider_session_id: session.id, provider_checkout_url: session.url,
    state: "open", updated_at: new Date().toISOString(),
  }).eq("id", attempt.id).select("*").single();
  if (updateError) throw updateError;
  return { attemptId: updated.id, checkoutUrl: updated.provider_checkout_url, state: updated.state, reused: false };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}
async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(signature).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function verifiedStripeEvent(request: Request, raw: string): Promise<Row> {
  if (!STRIPE_WEBHOOK_SECRET) throw new PortalError(503, "Webhook verification is not configured.");
  const header = request.headers.get("stripe-signature") || "";
  const parts = header.split(",").map((part) => part.split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1] || "";
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !signatures.length) {
    throw new PortalError(400, "Invalid Stripe webhook signature.");
  }
  const expected = await hmacHex(STRIPE_WEBHOOK_SECRET, `${timestamp}.${raw}`);
  const encoder = new TextEncoder();
  if (!signatures.some((value) => bytesEqual(encoder.encode(value), encoder.encode(expected)))) {
    throw new PortalError(400, "Invalid Stripe webhook signature.");
  }
  const event = JSON.parse(raw) as Row;
  if (!event.id || !event.type || !event.data) throw new PortalError(400, "Invalid Stripe event.");
  return event;
}

async function handleWebhook(request: Request): Promise<Response> {
  const raw = await request.text();
  const event = await verifiedStripeEvent(request, raw);
  const object = event.data && typeof event.data === "object" ? (event.data as Row).object as Row : {};
  if (!object?.id) return json(request, { received: true });
  if (event.type === "checkout.session.completed" && object.payment_status === "paid") {
    await service.from("portal_payment_attempt").update({
      state: "completed", provider_payment_id: object.payment_intent || null,
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("provider_session_id", object.id).eq("amount_cents", Number(object.amount_total || -1));
  } else if (event.type === "checkout.session.expired") {
    await service.from("portal_payment_attempt").update({
      state: "expired", provider_checkout_url: null, updated_at: new Date().toISOString(),
    }).eq("provider_session_id", object.id).eq("state", "open");
  }
  return json(request, { received: true });
}

async function listAttempts(caller: Caller): Promise<Row> {
  let query = service.from("portal_payment_attempt").select(
    "id,quickbooks_invoice_id,invoice_number,organization,store_license,amount_cents,currency,state,created_at,completed_at,reconciled_at",
  ).order("created_at", { ascending: false }).limit(100);
  if (!caller.internal) query = query.eq("organization", caller.profile.org);
  const { data, error } = await query;
  if (error) throw error;
  return {
    enabled: PAYMENT_COLLECTION_ENABLED && Boolean(STRIPE_SECRET_KEY) && Boolean(STRIPE_WEBHOOK_SECRET),
    provider: "Stripe Checkout", attempts: data ?? [],
    policy: { invoiceSource: "latest production QuickBooks snapshot", automaticQuickBooksWrite: false },
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  try {
    const url = new URL(request.url);
    if (request.method === "POST" && url.searchParams.get("webhook") === "stripe") {
      return await handleWebhook(request);
    }
    if (!new Set(["GET", "POST"]).has(request.method)) return json(request, { error: "Method not allowed" }, 405);
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Unauthorized" }, 401);
    if (request.method === "GET") return json(request, await listAttempts(caller));
    const body = await request.json() as Row;
    if (clean(body.action, 40) === "create-checkout") return json(request, await createCheckout(caller, body), 201);
    throw new PortalError(400, "Unsupported payment action.");
  } catch (error) {
    if (!(error instanceof PortalError)) console.error("portal-payments", error);
    return json(request, { error: error instanceof PortalError ? error.message : "The payment service is temporarily unavailable." },
      error instanceof PortalError ? error.status : 502);
  }
});
