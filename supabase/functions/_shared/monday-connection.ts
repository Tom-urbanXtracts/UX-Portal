import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

type Row = Record<string, unknown>;

export type MondayConnectionConfig = {
  encryptionKey: string;
  clientId: string;
  clientSecret: string;
};

function cleanToken(value: unknown): string {
  return String(value ?? "").trim().slice(0, 20_000);
}

export function mondayTokenExpiry(
  accessToken: string,
  expiresIn?: unknown,
): string | null {
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  try {
    const payload = accessToken.split(".")[1];
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - payload.length % 4) % 4);
    const exp = Number((JSON.parse(atob(padded)) as Row).exp);
    return Number.isFinite(exp) && exp > 0
      ? new Date(exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

function usableForFiveMinutes(value: unknown): boolean {
  if (!value) return true;
  const expiresAt = new Date(String(value)).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 5 * 60_000;
}

async function decryptedConnection(
  service: SupabaseClient,
  encryptionKey: string,
): Promise<Row | null> {
  const { data, error } = await service.rpc("portal_get_monday_connection", {
    p_encryption_key: encryptionKey,
  });
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] as Row : null;
}

export async function mondayAccessToken(
  service: SupabaseClient,
  config: MondayConnectionConfig,
  requiredScopes: string[],
): Promise<string | null> {
  if (config.encryptionKey.length < 32) return null;
  const { data: state, error: stateError } = await service.from(
    "monday_connection_state",
  ).select("connection_status,granted_scopes").eq("id", 1).maybeSingle();
  if (stateError) throw stateError;
  const scopes = Array.isArray(state?.granted_scopes)
    ? state.granted_scopes.map(String)
    : [];
  if (
    state?.connection_status !== "connected" ||
    requiredScopes.some((scope) => !scopes.includes(scope))
  ) return null;

  const connection = await decryptedConnection(service, config.encryptionKey);
  const currentAccessToken = cleanToken(connection?.access_token);
  if (
    connection?.connection_status !== "connected" || !currentAccessToken
  ) return null;
  if (usableForFiveMinutes(connection.access_token_expires_at)) {
    return currentAccessToken;
  }

  const currentRefreshToken = cleanToken(connection.refresh_token);
  if (!currentRefreshToken || !config.clientId || !config.clientSecret) {
    return null;
  }
  const refreshResponse = await fetch(
    "https://auth.monday.com/oauth_ms/oauth/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: currentRefreshToken,
      }),
    },
  );
  const tokenBody = await refreshResponse.json().catch(() => ({})) as Row;
  const nextAccessToken = cleanToken(tokenBody.access_token);
  const nextRefreshToken = cleanToken(tokenBody.refresh_token);
  if (!refreshResponse.ok || !nextAccessToken || !nextRefreshToken) {
    // Another request may have won a refresh-token rotation race. Re-read the
    // encrypted record before declaring that the connection needs attention.
    const current = await decryptedConnection(service, config.encryptionKey);
    const rotatedAccessToken = cleanToken(current?.access_token);
    if (
      rotatedAccessToken && rotatedAccessToken !== currentAccessToken &&
      usableForFiveMinutes(current?.access_token_expires_at)
    ) return rotatedAccessToken;
    throw new Error("Monday authorization could not renew its access token.");
  }
  const expiresAt = mondayTokenExpiry(nextAccessToken, tokenBody.expires_in);
  const { error: rotateError } = await service.rpc(
    "portal_rotate_monday_tokens",
    {
      p_access_token: nextAccessToken,
      p_refresh_token: nextRefreshToken,
      p_encryption_key: config.encryptionKey,
      p_access_token_expires_at: expiresAt,
    },
  );
  if (rotateError) throw rotateError;
  return nextAccessToken;
}
