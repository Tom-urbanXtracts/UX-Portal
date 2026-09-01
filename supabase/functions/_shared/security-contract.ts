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

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function verifyHs256Jwt(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ContractRow | null> {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || secret.length < 16) return null;
  const headerBytes = decodeBase64Url(parts[0]);
  const payloadBytes = decodeBase64Url(parts[1]);
  const suppliedSignature = decodeBase64Url(parts[2]);
  if (!headerBytes || !payloadBytes || !suppliedSignature) return null;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const header = JSON.parse(decoder.decode(headerBytes)) as ContractRow;
    const payload = JSON.parse(decoder.decode(payloadBytes)) as ContractRow;
    if (header.alg !== "HS256" || typeof payload !== "object" || !payload) {
      return null;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expectedSignature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ),
    );
    if (!sameBytes(expectedSignature, suppliedSignature)) return null;
    const expiresAt = Number(payload.exp);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds - 30) {
      return null;
    }
    const notBefore = Number(payload.nbf);
    if (Number.isFinite(notBefore) && notBefore > nowSeconds + 30) return null;
    const issuedAt = Number(payload.iat);
    if (Number.isFinite(issuedAt) && issuedAt > nowSeconds + 300) return null;
    return payload;
  } catch {
    return null;
  }
}
