export type ContractRow = Record<string, unknown>;

export function normalizedLabState(row: ContractRow): string {
  return String(row.test_result_status || row.lab_test_status || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function labPassed(row: ContractRow): boolean {
  return normalizedLabState(row) === "testpassed";
}

export function labFailed(row: ContractRow): boolean {
  return normalizedLabState(row) === "testfailed";
}

const ORDER_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object
  .freeze({
    awaiting_owner_approval: Object.freeze(["ordered", "declined"]),
    ordered: Object.freeze(["approved", "canceled"]),
    approved: Object.freeze(["processed", "canceled"]),
    processed: Object.freeze(["delivered"]),
    delivered: Object.freeze([]),
    declined: Object.freeze([]),
    canceled: Object.freeze([]),
  });

export function orderTransitionAllowed(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

const MONDAY_ORDER_STATES: Readonly<Record<string, string>> = Object.freeze({
  delivered: "delivered",
  received: "delivered",
  "customer accepted": "delivered",
  shipped: "processed",
  processing: "processed",
  processed: "processed",
  fulfilled: "processed",
  "ready for delivery": "processed",
  complete: "processed",
  completed: "processed",
  approved: "approved",
  confirmed: "approved",
  canceled: "canceled",
  cancelled: "canceled",
  declined: "canceled",
  rejected: "canceled",
  flagged: "canceled",
  exception: "canceled",
  ordered: "ordered",
  "new order": "ordered",
  placed: "ordered",
  submitted: "ordered",
});

export function mondayOrderState(value: unknown): string | null {
  const state = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .trim();
  return MONDAY_ORDER_STATES[state] ?? null;
}

export function canonicalCanixProductId(value: unknown): string | null {
  const matched = /^canix:item:([0-9]+)$/.exec(String(value ?? "").trim());
  if (!matched) return null;
  const itemId = BigInt(matched[1]);
  return itemId > 0n ? `canix:item:${itemId}` : null;
}

export function approvedHttpsUrl(
  value: unknown,
  allowedHosts: ReadonlySet<string>,
): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !allowedHosts.has(host)) return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== "443") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
