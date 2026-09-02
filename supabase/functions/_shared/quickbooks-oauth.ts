const DISCOVERY_URL =
  "https://developer.api.intuit.com/.well-known/openid_configuration";

export type IntuitOAuthEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

let endpointRequest: Promise<IntuitOAuthEndpoints> | null = null;

function validatedEndpoint(
  value: unknown,
  expectedHost: string,
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`Intuit discovery returned an invalid ${label}.`);
  }
  if (url.protocol !== "https:" || url.hostname !== expectedHost) {
    throw new Error(`Intuit discovery returned an untrusted ${label}.`);
  }
  return url.toString();
}

async function discover(): Promise<IntuitOAuthEndpoints> {
  const response = await fetch(DISCOVERY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(
      `Intuit OAuth discovery returned ${response.status}.`,
    );
  }
  const body = await response.json() as Record<string, unknown>;
  if (body.issuer !== "https://oauth.platform.intuit.com/op/v1") {
    throw new Error("Intuit discovery returned an unexpected issuer.");
  }
  return {
    authorizationEndpoint: validatedEndpoint(
      body.authorization_endpoint,
      "appcenter.intuit.com",
      "authorization endpoint",
    ),
    tokenEndpoint: validatedEndpoint(
      body.token_endpoint,
      "oauth.platform.intuit.com",
      "token endpoint",
    ),
  };
}

export async function intuitOAuthEndpoints(): Promise<IntuitOAuthEndpoints> {
  if (!endpointRequest) {
    endpointRequest = discover().catch((error) => {
      endpointRequest = null;
      throw error;
    });
  }
  return await endpointRequest;
}
