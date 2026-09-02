import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID") ?? "";
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET") ?? "";
const QBO_REALM_ID = Deno.env.get("QBO_REALM_ID") ?? "";
const QBO_REFRESH_TOKEN = Deno.env.get("QBO_REFRESH_TOKEN") ?? "";
const QBO_TOKEN_ENCRYPTION_KEY = Deno.env.get("QBO_TOKEN_ENCRYPTION_KEY") ?? "";
const QBO_CRON_SECRET = Deno.env.get("QBO_CRON_SECRET") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;

class IntuitApiError extends Error {
  intuitTid: string | null;

  constructor(message: string, intuitTid: string | null) {
    super(message);
    this.name = "IntuitApiError";
    this.intuitTid = intuitTid;
  }
}

function intuitTraceId(response: Response): string | null {
  const value = (response.headers.get("intuit_tid") ?? "")
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 160);
  return value || null;
}

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
      "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
      "https://portal.urbanxtracts.com",
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
    "access-control-allow-headers":
      "authorization, apikey, content-type, x-cron-secret",
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

async function authenticate(request: Request): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return false;
  const user = await response.json();
  const { data: profile } = await service.from("portal_profile").select(
    "role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (!profile || profile.active === false || profile.role !== "internal") {
    return false;
  }
  const { data: grant } = await service.from("portal_role_permission").select(
    "permission",
  ).eq("staff_role", profile.staff_role).eq("permission", "accounts.manage")
    .maybeSingle();
  return Boolean(grant);
}

async function accessToken(): Promise<
  {
    token: string;
    refresh: string;
    realm: string;
    refreshExpiresAt: string | null;
  }
> {
  let encrypted: Row | null = null;
  if (QBO_TOKEN_ENCRYPTION_KEY) {
    const { data, error } = await service.rpc(
      "portal_get_quickbooks_connection",
      {
        p_encryption_key: QBO_TOKEN_ENCRYPTION_KEY,
      },
    );
    if (error) throw error;
    encrypted = Array.isArray(data) && data.length ? data[0] as Row : null;
  }
  const { data: legacy } = await service.from("quickbooks_sync_state").select(
    "realm_id,refresh_token",
  ).eq("id", 1).maybeSingle();
  const refresh = String(
    encrypted?.refresh_token || legacy?.refresh_token || QBO_REFRESH_TOKEN,
  );
  const realm = String(encrypted?.realm_id || legacy?.realm_id || QBO_REALM_ID);
  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !realm || !refresh) {
    throw new Error("QuickBooks server credentials are not configured.");
  }
  const response = await fetch(
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
      }),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new IntuitApiError(
      body.error_description || body.error ||
        `QuickBooks token refresh returned ${response.status}.`,
      intuitTraceId(response),
    );
  }
  const refreshSeconds = Number(body.x_refresh_token_expires_in || 0);
  const refreshExpiresAt = Number.isFinite(refreshSeconds) && refreshSeconds > 0
    ? new Date(Date.now() + refreshSeconds * 1000).toISOString()
    : null;
  return {
    token: body.access_token,
    refresh: body.refresh_token || refresh,
    realm,
    refreshExpiresAt,
  };
}

async function qboQuery(
  auth: { token: string; realm: string },
  entity: string,
  where = "",
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let start = 1; start <= 100_000; start += 1000) {
    const query = `select * from ${entity}${
      where ? ` ${where}` : ""
    } startposition ${start} maxresults 1000`;
    const response = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${
        encodeURIComponent(auth.realm)
      }/query?minorversion=75&query=${encodeURIComponent(query)}`,
      {
        headers: {
          authorization: `Bearer ${auth.token}`,
          accept: "application/json",
        },
      },
    );
    const body = await response.json();
    if (!response.ok) {
      throw new IntuitApiError(
        body?.Fault?.Error?.[0]?.Message ||
          `QuickBooks ${entity} query returned ${response.status}.`,
        intuitTraceId(response),
      );
    }
    const page = Array.isArray(body?.QueryResponse?.[entity])
      ? body.QueryResponse[entity] as Row[]
      : [];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function upsertChunks(
  table: string,
  rows: Row[],
  onConflict: string,
): Promise<void> {
  for (let start = 0; start < rows.length; start += 500) {
    const { error } = await service.from(table).upsert(
      rows.slice(start, start + 500),
      { onConflict },
    );
    if (error) throw error;
  }
}

function refValue(value: unknown): string | null {
  return value && typeof value === "object" && "value" in value
    ? String((value as Row).value || "") || null
    : null;
}

function refName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Row;
  return String(row.name || row.value || "") || null;
}

function paymentAllocations(payment: Row): Row[] {
  const allocations: Row[] = [];
  const lines = Array.isArray(payment.Line) ? payment.Line as Row[] : [];
  for (const line of lines) {
    const links = Array.isArray(line.LinkedTxn) ? line.LinkedTxn as Row[] : [];
    for (const link of links) {
      if (String(link.TxnType || "").toLowerCase() !== "invoice") continue;
      allocations.push({
        invoiceId: String(link.TxnId || ""),
        amount: Number(line.Amount || 0),
      });
    }
  }
  return allocations.filter((allocation) => allocation.invoiceId);
}

async function syncQuickBooks(): Promise<
  { customerCount: number; invoiceCount: number; paymentCount: number }
> {
  await service.from("quickbooks_sync_state").update({
    status: "running",
    last_started_at: new Date().toISOString(),
    last_error: null,
    last_intuit_tid: null,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
  let pendingRunId: string | null = null;
  try {
    const auth = await accessToken();
    // Intuit rotates refresh tokens. Persist the replacement before any data
    // query so a downstream failure cannot strand the connector with an
    // already-retired token.
    const tokenSavedAt = new Date().toISOString();
    const { error: tokenError } = QBO_TOKEN_ENCRYPTION_KEY
      ? await service.rpc("portal_rotate_quickbooks_refresh_token", {
        p_refresh_token: auth.refresh,
        p_encryption_key: QBO_TOKEN_ENCRYPTION_KEY,
        p_refresh_token_expires_at: auth.refreshExpiresAt,
      })
      : await service.from("quickbooks_sync_state").update({
        realm_id: auth.realm,
        refresh_token: auth.refresh,
        updated_at: tokenSavedAt,
      }).eq("id", 1);
    if (tokenError) throw tokenError;

    const [customers, invoices, payments] = await Promise.all([
      qboQuery(auth, "Customer", "where Active in (true, false)"),
      qboQuery(auth, "Invoice"),
      qboQuery(auth, "Payment"),
    ]);
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    pendingRunId = runId;
    const rows = customers.map((customer: Row) => ({
      quickbooks_customer_id: String(customer.Id),
      display_name: String(
        customer.DisplayName || customer.CompanyName || customer.Id,
      ),
      company_name: customer.CompanyName || null,
      active: customer.Active !== false,
      balance: customer.Balance ?? null,
      balance_with_jobs: customer.BalanceWithJobs ?? null,
      currency: (customer.CurrencyRef as Row | undefined)?.value || null,
      parent_customer_id: (customer.ParentRef as Row | undefined)?.value ||
        null,
      email: (customer.PrimaryEmailAddr as Row | undefined)?.Address || null,
      billing_city: (customer.BillAddr as Row | undefined)?.City || null,
      source_updated_at:
        (customer.MetaData as Row | undefined)?.LastUpdatedTime || null,
      synced_at: now,
      // The financial portal does not need the full accounting payload. Keep
      // the legacy column empty instead of copying addresses, tax metadata, or
      // other QuickBooks fields into a second system.
      raw: {},
    }));
    const invoiceRows = invoices.flatMap((invoice: Row) => {
      const customerId = refValue(invoice.CustomerRef);
      if (!customerId || !invoice.Id) return [];
      return [{
        quickbooks_invoice_id: String(invoice.Id),
        sync_run_id: runId,
        quickbooks_customer_id: customerId,
        doc_number: invoice.DocNumber || null,
        txn_date: invoice.TxnDate || null,
        due_date: invoice.DueDate || null,
        total_amount: Number(invoice.TotalAmt || 0),
        balance: Number(invoice.Balance || 0),
        currency: refValue(invoice.CurrencyRef),
        email_status: invoice.EmailStatus || null,
        print_status: invoice.PrintStatus || null,
        source_updated_at:
          (invoice.MetaData as Row | undefined)?.LastUpdatedTime || null,
        synced_at: now,
      }];
    });
    const paymentRows = payments.flatMap((payment: Row) => {
      const customerId = refValue(payment.CustomerRef);
      if (!customerId || !payment.Id) return [];
      return [{
        quickbooks_payment_id: String(payment.Id),
        sync_run_id: runId,
        quickbooks_customer_id: customerId,
        txn_date: payment.TxnDate || null,
        total_amount: Number(payment.TotalAmt || 0),
        unapplied_amount: Number(payment.UnappliedAmt || 0),
        currency: refValue(payment.CurrencyRef),
        payment_method_name: refName(payment.PaymentMethodRef),
        invoice_allocations: paymentAllocations(payment),
        source_updated_at:
          (payment.MetaData as Row | undefined)?.LastUpdatedTime || null,
        synced_at: now,
      }];
    });

    await upsertChunks(
      "quickbooks_customer_cache",
      rows,
      "quickbooks_customer_id",
    );
    await upsertChunks(
      "quickbooks_invoice_cache",
      invoiceRows,
      "quickbooks_invoice_id,sync_run_id",
    );
    await upsertChunks(
      "quickbooks_payment_cache",
      paymentRows,
      "quickbooks_payment_id,sync_run_id",
    );
    const { error: stateError } = await service.from("quickbooks_sync_state")
      .update({
        realm_id: auth.realm,
        refresh_token: QBO_TOKEN_ENCRYPTION_KEY ? null : auth.refresh,
        status: "ok",
        last_successful_at: now,
        connection_status: "connected",
        financial_last_successful_at: now,
        last_financial_run_id: runId,
        last_error: null,
        customer_count: rows.length,
        invoice_count: invoiceRows.length,
        payment_count: paymentRows.length,
        updated_at: now,
        last_intuit_tid: null,
      }).eq("id", 1);
    if (stateError) throw stateError;

    // A completed run is now authoritative, so prior financial snapshots can
    // be discarded. If any step above failed, this cleanup is never reached
    // and the prior successful run remains fully readable.
    await Promise.all([
      service.from("quickbooks_invoice_cache").delete().neq(
        "sync_run_id",
        runId,
      ),
      service.from("quickbooks_payment_cache").delete().neq(
        "sync_run_id",
        runId,
      ),
    ]);
    pendingRunId = null;
    return {
      customerCount: rows.length,
      invoiceCount: invoiceRows.length,
      paymentCount: paymentRows.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const traceId = error instanceof IntuitApiError ? error.intuitTid : null;
    if (pendingRunId) {
      await Promise.all([
        service.from("quickbooks_invoice_cache").delete().eq(
          "sync_run_id",
          pendingRunId,
        ),
        service.from("quickbooks_payment_cache").delete().eq(
          "sync_run_id",
          pendingRunId,
        ),
      ]);
    }
    await service.from("quickbooks_sync_state").update({
      status: "error",
      connection_status: "error",
      last_error: message.slice(0, 2000),
      last_intuit_tid: traceId,
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    console.error("quickbooks-retailers", {
      message: message.slice(0, 2000),
      intuitTid: traceId,
    });
    throw error;
  }
}

async function cachedAccounts(): Promise<Row[]> {
  const { data, error } = await service.from("quickbooks_customer_cache")
    .select("*").order("display_name");
  if (error) throw error;
  const customerIds = (data ?? []).map((row) =>
    String(row.quickbooks_customer_id)
  );
  const { data: portalAccounts, error: accountError } = customerIds.length
    ? await service.from("portal_retailer_account")
      .select(
        "id,quickbooks_customer_id,organization_name,display_name,portal_status,status_note,updated_at",
      )
      .in("quickbooks_customer_id", customerIds)
    : { data: [], error: null };
  if (accountError) throw accountError;
  const accountIds = (portalAccounts ?? []).map((account) =>
    String(account.id)
  );
  const { data: stores, error: storeError } = accountIds.length
    ? await service.from("portal_store")
      .select(
        "retailer_account_id,license_number,quickbooks_customer_id,display_name,address,active,license_status,ordering_status,ordering_hold_reason,license_expires_on,qualified_at,closed_at,updated_at",
      )
      .in("retailer_account_id", accountIds).order("display_name")
    : { data: [], error: null };
  if (storeError) throw storeError;
  return (data ?? []).map((row: Row) => {
    const account = (portalAccounts ?? []).find((candidate) =>
      candidate.quickbooks_customer_id === row.quickbooks_customer_id
    );
    const accountStores = account
      ? (stores ?? []).filter((store) =>
        store.retailer_account_id === account.id && !store.closed_at
      )
      : [];
    return {
      id: `qbo:customer:${row.quickbooks_customer_id}`,
      quickbooksCustomerId: row.quickbooks_customer_id,
      name: row.display_name,
      company: row.company_name,
      active: row.active,
      balance: row.balance,
      balanceWithJobs: row.balance_with_jobs,
      currency: row.currency || "USD",
      portalAccountId: account?.id ?? null,
      portalStatus: account?.portal_status ?? "not_qualified",
      portalStatusNote: account?.status_note ?? null,
      portalUpdatedAt: account?.updated_at ?? null,
      organizationName: account?.organization_name ?? row.company_name ??
        row.display_name,
      locations: accountStores.length,
      stores: accountStores.map((store) => ({
        name: store.display_name,
        license: store.license_number,
        quickbooksCustomerId: store.quickbooks_customer_id,
        address: store.address,
        active: store.active,
        licenseStatus: store.license_status,
        orderingStatus: store.ordering_status,
        holdReason: store.ordering_hold_reason,
        licenseExpiresOn: store.license_expires_on,
        qualifiedAt: store.qualified_at,
        updatedAt: store.updated_at,
      })),
      sourceUpdatedAt: row.source_updated_at,
      syncedAt: row.synced_at,
      source: "QuickBooks customer",
    };
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const cron = request.method === "POST" && QBO_CRON_SECRET &&
      request.headers.get("x-cron-secret") === QBO_CRON_SECRET;
    if (!cron && !(await authenticate(request))) {
      return json(request, { error: "Forbidden" }, 403);
    }
    if (request.method === "POST") {
      const counts = await syncQuickBooks();
      return json(request, {
        ok: true,
        ...counts,
        accounts: await cachedAccounts(),
      });
    }
    let accounts = await cachedAccounts();
    if (!accounts.length) {
      await syncQuickBooks();
      accounts = await cachedAccounts();
    }
    return json(request, { accounts });
  } catch (error) {
    console.error("quickbooks-retailers", error);
    return json(request, {
      error: "QuickBooks customers are temporarily unavailable.",
    }, 502);
  }
});
