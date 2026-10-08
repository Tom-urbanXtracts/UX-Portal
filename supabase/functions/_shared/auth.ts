type AuthenticatedClaims = {
  role?: unknown;
  sub?: unknown;
};

function claimsFromAuthorization(
  authorization: string,
): AuthenticatedClaims | null {
  const token = String(authorization || "").replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - normalized.length % 4) % 4),
      "=",
    );
    return JSON.parse(atob(padded)) as AuthenticatedClaims;
  } catch (_) {
    return null;
  }
}

// Call this only after Supabase Auth has validated the bearer token. This is a
// defense-in-depth assertion that the validated token represents an
// authenticated user; organization and capability checks still happen in each
// handler and through RLS.
export function verifiedTokenIsAuthenticated(authorization: string): boolean {
  const claims = claimsFromAuthorization(authorization);
  return claims?.role === "authenticated" && typeof claims.sub === "string" &&
    claims.sub.length > 0;
}
