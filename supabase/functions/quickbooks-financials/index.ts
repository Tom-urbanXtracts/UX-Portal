import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Caller = { user: Row; profile: Row; internal: boolean };
type CustomerScope = {
  customerId: string;
  organization: string;
  locationName: string;
  license: string | null;
};

class PortalError extends Error {
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
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
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

function clean(value: unknown, max = 160): string {
  return String(value ?? "").trim().slice(0, max);
}

function cents(value: unknown): number {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function dayDistance(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

async function callerFor(request: Request): Promise<Caller | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile, error } = await service.from("portal_profile")
    .select("id,org,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (error || !profile || profile.active === false) return null;
  if (profile.role === "internal") {
    const { data: grant } = await service.from("portal_role_permission").select(
      "permission",
    )
      .eq("staff_role", profile.staff_role).eq("permission", "financials.read")
      .maybeSingle();
    if (!grant) {
      throw new PortalError(
        403,
        "Financial access is not included in this workforce preset.",
      );
    }
    return { user, profile: profile as Row, internal: true };
  }
  if (!["owner", "buyer"].includes(String(profile.role))) {
    throw new PortalError(
      403,
      "Financial history is available only to Store Owners and Buyers.",
    );
  }
  return { user, profile: profile as Row, internal: false };
}

async function customerScope(
  caller: Caller,
): Promise<{ rows: CustomerScope[]; missing: Row[] }> {
  let accountQuery = service.from("portal_retailer_account")
    .select("id,organization_name,display_name,quickbooks_customer_id");
  if (!caller.internal) {
    accountQuery = accountQuery.eq("organization_name", caller.profile.org);
  }
  const { data: accounts, error: accountError } = await accountQuery;
  if (accountError) throw accountError;
  if (!caller.internal && !accounts?.length) {
    throw new PortalError(
      409,
      "This retailer profile is not linked to a QuickBooks customer yet.",
    );
  }
  const accountIds = (accounts ?? []).map((account) => String(account.id));
  const { data: storeMappings, error: storeError } = accountIds.length
    ? await service.from("portal_store")
      .select(
        "retailer_account_id,organization,display_name,license_number,quickbooks_customer_id,active,closed_at",
      )
      .in("retailer_account_id", accountIds).order("display_name")
    : { data: [], error: null };
  if (storeError) throw storeError;
  const allStores = storeMappings ?? [];
  const candidateCustomerIds = Array.from(
    new Set([
      ...allStores.map((store) => clean(store.quickbooks_customer_id)).filter(
        Boolean,
      ),
      ...(accounts ?? []).map((account) =>
        clean(account.quickbooks_customer_id)
      ).filter(Boolean),
    ]),
  );
  const { data: collisionStores, error: collisionError } = !caller.internal &&
      caller.profile.role === "buyer" && candidateCustomerIds.length
    ? await service.from("portal_store")
      .select(
        "retailer_account_id,organization,display_name,license_number,quickbooks_customer_id,active,closed_at",
      )
      .in("quickbooks_customer_id", candidateCustomerIds)
    : { data: allStores, error: null };
  if (collisionError) throw collisionError;
  const { data: collisionAccounts, error: collisionAccountError } =
    !caller.internal && caller.profile.role === "buyer" &&
      candidateCustomerIds.length
      ? await service.from("portal_retailer_account")
        .select("id,organization_name,quickbooks_customer_id")
        .in("quickbooks_customer_id", candidateCustomerIds)
      : { data: accounts, error: null };
  if (collisionAccountError) throw collisionAccountError;
  const stores = allStores.filter((store) =>
    store.active === true && !store.closed_at
  );

  let allowedLicenses: string[] | null = null;
  if (!caller.internal && caller.profile.role === "buyer") {
    const { data: assignments, error: assignmentError } = await service.from(
      "portal_profile_store",
    )
      .select("license_number").eq("profile_id", caller.profile.id);
    if (assignmentError) throw assignmentError;
    allowedLicenses = (assignments ?? []).map((assignment) =>
      String(assignment.license_number)
    );
  }

  const accountById = new Map(
    (accounts ?? []).map((account) => [String(account.id), account]),
  );
  const scopedStores = (stores ?? []).filter((store) =>
    allowedLicenses === null ||
    allowedLicenses.includes(String(store.license_number))
  );
  const rows = new Map<string, CustomerScope>();
  const missing: Row[] = [];
  const allStoresByCustomer = new Map<string, Row[]>();
  for (const store of collisionStores ?? []) {
    const customerId = clean(store.quickbooks_customer_id);
    if (!customerId) continue;
    allStoresByCustomer.set(
      customerId,
      (allStoresByCustomer.get(customerId) ?? []).concat([
        store as unknown as Row,
      ]),
    );
  }
  const deniedSharedCustomers = new Set<string>();
  for (const store of scopedStores) {
    const account = accountById.get(String(store.retailer_account_id));
    const customerId = clean(store.quickbooks_customer_id);
    if (!customerId) {
      missing.push({
        organization: store.organization,
        locationName: store.display_name,
        license: store.license_number,
      });
      continue;
    }
    const allMappedStores = allStoresByCustomer.get(customerId) ?? [];
    const mappedAccounts = (collisionAccounts ?? []).filter((candidate) =>
      clean(candidate.quickbooks_customer_id) === customerId
    );
    const parentCustomerOutsideOrganization = mappedAccounts.some((candidate) =>
      String(candidate.id) !== String(store.retailer_account_id)
    );
    const accountStores = allStores.filter((candidate) =>
      String(candidate.retailer_account_id) ===
        String(store.retailer_account_id)
    );
    const parentCustomerOutsideAssignment = caller.profile.role === "buyer" &&
      customerId === clean(account?.quickbooks_customer_id) &&
      accountStores.some((candidate) =>
        !allowedLicenses?.includes(String(candidate.license_number))
      );
    if (
      caller.profile.role === "buyer" &&
      (parentCustomerOutsideOrganization || parentCustomerOutsideAssignment ||
        allMappedStores.some((mapped) =>
          !allowedLicenses?.includes(String(mapped.license_number))
        ))
    ) {
      if (!deniedSharedCustomers.has(customerId)) {
        missing.push({
          organization: store.organization,
          locationName: store.display_name,
          license: store.license_number,
          reason: "shared_quickbooks_customer_outside_assignment",
        });
        deniedSharedCustomers.add(customerId);
      }
      continue;
    }
    const shared = allMappedStores.length > 1;
    rows.set(customerId, {
      customerId,
      organization: String(
        store.organization || account?.organization_name || "Retailer",
      ),
      locationName: shared
        ? "Shared QuickBooks customer"
        : String(store.display_name || store.license_number),
      license: shared ? null : String(store.license_number),
    });
  }

  // An Owner may see organization-level accounting records in addition to all
  // stores. A Buyer never inherits this parent ID because it could include
  // invoices for stores outside that Buyer's assignment.
  if (caller.internal || caller.profile.role === "owner") {
    for (const account of accounts ?? []) {
      const customerId = clean(account.quickbooks_customer_id);
      if (!customerId || rows.has(customerId)) continue;
      rows.set(customerId, {
        customerId,
        organization: String(account.organization_name),
        locationName: "Organization account",
        license: null,
      });
    }
  }
  return { rows: Array.from(rows.values()), missing };
}

function invoiceState(
  row: Row,
  today: string,
): { state: string; daysPastDue: number } {
  if (Number(row.balance || 0) <= 0) return { state: "paid", daysPastDue: 0 };
  const due = clean(row.due_date, 10);
  if (due && due < today) {
    return { state: "past_due", daysPastDue: dayDistance(due, today) };
  }
  return { state: "open", daysPastDue: 0 };
}

function sortRows(rows: Row[], key: string, direction: string): Row[] {
  const supported = new Set([
    "txnDate",
    "dueDate",
    "totalAmountCents",
    "balanceCents",
    "docNumber",
    "state",
    "locationName",
  ]);
  const selected = supported.has(key) ? key : "txnDate";
  const multiplier = direction === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = a[selected];
    const bv = b[selected];
    const compared = typeof av === "number" || typeof bv === "number"
      ? Number(av || 0) - Number(bv || 0)
      : String(av || "").localeCompare(String(bv || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    return (compared || String(a.id).localeCompare(String(b.id))) * multiplier;
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "GET") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const caller = await callerFor(request);
    if (!caller) return json(request, { error: "Unauthorized" }, 401);
    const { data: state, error: stateError } = await service.from(
      "quickbooks_sync_state",
    )
      .select(
        "status,last_financial_run_id,financial_last_successful_at,invoice_count,payment_count",
      )
      .eq("id", 1).maybeSingle();
    if (stateError) throw stateError;
    if (!state?.last_financial_run_id) {
      return json(request, {
        source: {
          system: "QuickBooks",
          connectionMode: "not_loaded",
          stale: true,
        },
        summary: null,
        byStore: [],
        invoices: [],
        payments: [],
        mappingIncomplete: [],
      });
    }

    const scope = await customerScope(caller);
    const customers = scope.rows.map((row) => row.customerId);
    const mapping = new Map(scope.rows.map((row) => [row.customerId, row]));
    if (!customers.length) {
      return json(request, {
        source: {
          system: "QuickBooks",
          connectionMode: "mapped_no_data",
          stale: state.status === "error",
          lastSuccessfulSyncAt: state.financial_last_successful_at,
        },
        summary: {
          outstandingCents: 0,
          pastDueCents: 0,
          paidCents: 0,
          openInvoiceCount: 0,
          invoiceCount: 0,
          paymentCount: 0,
        },
        byStore: [],
        invoices: [],
        payments: [],
        mappingIncomplete: scope.missing,
      });
    }

    const [invoiceResult, paymentResult] = await Promise.all([
      service.from("quickbooks_invoice_cache").select("*")
        .eq("sync_run_id", state.last_financial_run_id).in(
          "quickbooks_customer_id",
          customers,
        ),
      service.from("quickbooks_payment_cache").select("*")
        .eq("sync_run_id", state.last_financial_run_id).in(
          "quickbooks_customer_id",
          customers,
        ),
    ]);
    if (invoiceResult.error) throw invoiceResult.error;
    if (paymentResult.error) throw paymentResult.error;

    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const statusFilter = clean(url.searchParams.get("status"), 24) || "all";
    const licenseFilter = clean(url.searchParams.get("license"), 120) || "all";
    const from = clean(url.searchParams.get("from"), 10);
    const to = clean(url.searchParams.get("to"), 10);
    const invoicesAll = (invoiceResult.data ?? []).map((row) => {
      const customer = mapping.get(
        String(row.quickbooks_customer_id),
      ) as CustomerScope;
      const stateValue = invoiceState(row as unknown as Row, today);
      return {
        id: row.quickbooks_invoice_id,
        customerId: row.quickbooks_customer_id,
        organization: customer.organization,
        locationName: customer.locationName,
        license: customer.license,
        docNumber: row.doc_number || row.quickbooks_invoice_id,
        txnDate: row.txn_date,
        dueDate: row.due_date,
        totalAmountCents: cents(row.total_amount),
        balanceCents: cents(row.balance),
        currency: row.currency || "USD",
        state: stateValue.state,
        daysPastDue: stateValue.daysPastDue,
      } as Row;
    });
    const paymentsAll = (paymentResult.data ?? []).map((row) => {
      const customer = mapping.get(
        String(row.quickbooks_customer_id),
      ) as CustomerScope;
      return {
        id: row.quickbooks_payment_id,
        customerId: row.quickbooks_customer_id,
        organization: customer.organization,
        locationName: customer.locationName,
        license: customer.license,
        txnDate: row.txn_date,
        totalAmountCents: cents(row.total_amount),
        unappliedAmountCents: cents(row.unapplied_amount),
        currency: row.currency || "USD",
        paymentMethod: row.payment_method_name || null,
        invoiceAllocations: Array.isArray(row.invoice_allocations)
          ? (row.invoice_allocations as Row[]).map((allocation) => ({
            invoiceId: allocation.invoiceId,
            amountCents: cents(allocation.amount),
          }))
          : [],
      } as Row;
    });
    const invoiceMatches = (row: Row) =>
      (statusFilter === "all" || row.state === statusFilter) &&
      (licenseFilter === "all" || row.license === licenseFilter) &&
      (!from || String(row.txnDate || "") >= from) &&
      (!to || String(row.txnDate || "") <= to);
    const paymentMatches = (row: Row) =>
      (licenseFilter === "all" || row.license === licenseFilter) &&
      (!from || String(row.txnDate || "") >= from) &&
      (!to || String(row.txnDate || "") <= to);
    const invoices = sortRows(
      invoicesAll.filter(invoiceMatches),
      clean(url.searchParams.get("sort"), 32),
      clean(url.searchParams.get("dir"), 8),
    );
    const payments = paymentsAll.filter(paymentMatches).sort((a, b) =>
      String(b.txnDate || "").localeCompare(String(a.txnDate || ""))
    );

    const storeKeys = Array.from(
      new Set(
        scope.rows.map((row) =>
          `${row.customerId}:${row.license || "account"}`
        ),
      ),
    );
    const byStore = storeKeys.map((key) => {
      const customer = scope.rows.find((row) =>
        `${row.customerId}:${row.license || "account"}` === key
      ) as CustomerScope;
      const storeInvoices = invoicesAll.filter((invoice) =>
        invoice.customerId === customer.customerId
      );
      const storePayments = paymentsAll.filter((payment) =>
        payment.customerId === customer.customerId
      );
      const open = storeInvoices.filter((invoice) => invoice.state !== "paid");
      const pastDue = storeInvoices.filter((invoice) =>
        invoice.state === "past_due"
      );
      return {
        customerId: customer.customerId,
        organization: customer.organization,
        locationName: customer.locationName,
        license: customer.license,
        billedCents: storeInvoices.reduce(
          (sum, invoice) => sum + Number(invoice.totalAmountCents || 0),
          0,
        ),
        outstandingCents: open.reduce(
          (sum, invoice) => sum + Number(invoice.balanceCents || 0),
          0,
        ),
        pastDueCents: pastDue.reduce(
          (sum, invoice) => sum + Number(invoice.balanceCents || 0),
          0,
        ),
        paidCents: storePayments.reduce(
          (sum, payment) => sum + Number(payment.totalAmountCents || 0),
          0,
        ),
        invoiceCount: storeInvoices.length,
        openInvoiceCount: open.length,
        paymentCount: storePayments.length,
        oldestPastDueDays: pastDue.reduce(
          (oldest, invoice) =>
            Math.max(oldest, Number(invoice.daysPastDue || 0)),
          0,
        ),
        creditLimitCents: null,
      };
    });
    const open = invoicesAll.filter((invoice) => invoice.state !== "paid");
    const pastDue = invoicesAll.filter((invoice) =>
      invoice.state === "past_due"
    );
    const sourceTime = String(state.financial_last_successful_at || "");
    const ageMinutes = sourceTime
      ? Math.max(0, Math.floor((Date.now() - Date.parse(sourceTime)) / 60_000))
      : null;
    return json(request, {
      source: {
        system: "QuickBooks",
        connectionMode: "server_snapshot",
        stale: state.status === "error",
        lastSuccessfulSyncAt: state.financial_last_successful_at,
        ageMinutes,
      },
      summary: {
        outstandingCents: open.reduce(
          (sum, invoice) => sum + Number(invoice.balanceCents || 0),
          0,
        ),
        pastDueCents: pastDue.reduce(
          (sum, invoice) => sum + Number(invoice.balanceCents || 0),
          0,
        ),
        billedCents: invoicesAll.reduce(
          (sum, invoice) => sum + Number(invoice.totalAmountCents || 0),
          0,
        ),
        paidCents: paymentsAll.reduce(
          (sum, payment) => sum + Number(payment.totalAmountCents || 0),
          0,
        ),
        openInvoiceCount: open.length,
        invoiceCount: invoicesAll.length,
        paymentCount: paymentsAll.length,
        creditLimitCents: null,
      },
      byStore,
      invoices,
      payments,
      mappingIncomplete: scope.missing,
      policy: {
        paymentCollectionEnabled: false,
        orderingGateInferredFromBalance: false,
      },
    });
  } catch (error) {
    console.error("quickbooks-financials", error);
    if (error instanceof PortalError) {
      return json(request, { error: error.message }, error.status);
    }
    return json(request, {
      error: "QuickBooks financial history is temporarily unavailable.",
    }, 502);
  }
});
