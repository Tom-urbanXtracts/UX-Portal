import { purchaseApprovalRoute } from "./internal-work-contract.ts";

export type SupplyOrderLineInput = {
  name: string | null;
  linkUrl: string | null;
  unitCost: number | null;
  quantity: number | null;
  sku: string | null;
  department: string | null;
  expenseCategory: string | null;
  expenseSubcategory: string | null;
  chartOfAccounts: string | null;
};

export type SupplyOrderInput = {
  requesterIds: number[];
  department: string | null;
  vendor: string | null;
  needBeforeDate: string | null;
  priority: string | null;
  lines: SupplyOrderLineInput[];
};

export type SupplyOrderValidation = {
  complete: boolean;
  missing: string[];
  total: number | null;
};

export type SupplyOrderRoute = {
  tier: "eric_500" | "leadership_2999" | "eran_3000";
  authority: string;
  mondayUserIds: number[];
};

const APPROVER_USER_IDS = Object.freeze({
  eric: 98722698,
  omeed: 50261465,
  drew: 49938939,
  jonathan: 50344762,
  eran: 50263474,
});

const PLACEHOLDER_TEXT = /^(?:n\/?a|none|null|unknown|tbd|test|-)$/i;
const PLACEHOLDER_HOSTS = new Set(["na.com", "www.na.com", "example.com"]);

function present(value: string | null): boolean {
  const trimmed = String(value ?? "").trim();
  return !!trimmed && !PLACEHOLDER_TEXT.test(trimmed);
}

function validPurchaseUrl(value: string | null): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !PLACEHOLDER_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function money(value: number | null): number | null {
  if (!Number.isFinite(value) || value === null || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

export function supplyOrderValidation(
  input: SupplyOrderInput,
): SupplyOrderValidation {
  const missing = new Set<string>();
  if (!input.requesterIds.length) missing.add("Order Requested by");
  if (!present(input.department)) missing.add("Department");
  if (!present(input.vendor)) missing.add("Vendor");
  if (!present(input.needBeforeDate)) missing.add("Need Before Date");
  if (!present(input.priority)) missing.add("Priority");
  if (!input.lines.length) missing.add("At least one item");

  let total = 0;
  input.lines.forEach((line, index) => {
    const label = `Item ${index + 1}`;
    if (!present(line.name)) missing.add(`${label}: item name`);
    if (!validPurchaseUrl(line.linkUrl)) missing.add(`${label}: purchase link`);
    const unitCost = money(line.unitCost);
    const quantity = money(line.quantity);
    if (unitCost === null) missing.add(`${label}: unit cost`);
    if (quantity === null) missing.add(`${label}: quantity`);
    if (unitCost !== null && quantity !== null) total += unitCost * quantity;
    if (!present(line.sku)) missing.add(`${label}: SKU`);
    if (!present(line.department)) missing.add(`${label}: department`);
    if (!present(line.expenseCategory)) {
      missing.add(`${label}: expense category`);
    }
    if (!present(line.expenseSubcategory)) {
      missing.add(`${label}: expense sub-category`);
    }
    if (!present(line.chartOfAccounts)) {
      missing.add(`${label}: chart of accounts`);
    }
  });

  const roundedTotal = Math.round(total * 100) / 100;
  if (roundedTotal <= 0) missing.add("Total estimated cost");
  return {
    complete: missing.size === 0,
    missing: Array.from(missing).sort(),
    total: roundedTotal > 0 ? roundedTotal : null,
  };
}

export function supplyOrderApprovalRoute(amount: number): SupplyOrderRoute {
  const route = purchaseApprovalRoute(amount);
  if (route.tier === "eric_500") {
    return { ...route, mondayUserIds: [APPROVER_USER_IDS.eric] };
  }
  if (route.tier === "leadership_2999") {
    return {
      ...route,
      mondayUserIds: [
        APPROVER_USER_IDS.omeed,
        APPROVER_USER_IDS.drew,
        APPROVER_USER_IDS.jonathan,
      ],
    };
  }
  return { ...route, mondayUserIds: [APPROVER_USER_IDS.eran] };
}

export function stableSupplyOrderHash(
  validation: SupplyOrderValidation,
  approvalStatus: string | null,
): string {
  return JSON.stringify({
    approvalStatus: approvalStatus ?? "",
    complete: validation.complete,
    missing: validation.missing,
    total: validation.total,
  });
}
