type Claims = Record<string, unknown>;

function claimsFromAuthorization(authorization: string): Claims | null {
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - normalized.length % 4) % 4),
      "=",
    );
    const claims = JSON.parse(atob(padded));
    return claims && typeof claims === "object" ? claims as Claims : null;
  } catch {
    return null;
  }
}

// Call only after Supabase Auth has successfully validated the bearer token.
// This helper enforces the assurance claim; it does not validate JWT signatures.
export function verifiedTokenHasAal2(authorization: string): boolean {
  return claimsFromAuthorization(authorization)?.aal === "aal2";
}
