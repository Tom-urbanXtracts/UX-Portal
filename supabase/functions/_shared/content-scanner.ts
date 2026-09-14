export type ScanVerdict = {
  verdict: "clean" | "infected";
  sha256: string;
  engine: string;
  engineResult?: string;
};

export class ContentScanError extends Error {
  verdict: "unavailable" | "infected" | "invalid";
  constructor(verdict: "unavailable" | "infected" | "invalid", message: string) {
    super(message);
    this.verdict = verdict;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

export function contentScannerConfigured(): boolean {
  return /^https:\/\//.test(Deno.env.get("DOCUMENT_SCANNER_URL") ?? "") &&
    (Deno.env.get("DOCUMENT_SCANNER_SHARED_SECRET") ?? "").length >= 32;
}

export async function scanContent(
  bytes: Uint8Array,
  expectedSha256?: string,
): Promise<ScanVerdict> {
  const url = (Deno.env.get("DOCUMENT_SCANNER_URL") ?? "").replace(/\/$/, "");
  const secret = Deno.env.get("DOCUMENT_SCANNER_SHARED_SECRET") ?? "";
  if (!/^https:\/\//.test(url) || secret.length < 32) {
    throw new ContentScanError(
      "unavailable",
      "The approved document scanner is not configured.",
    );
  }
  const digest = (expectedSha256 || await sha256Hex(bytes)).toLowerCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${url}/scan`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "x-content-sha256": digest,
      },
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 422 && body.verdict === "infected") {
      throw new ContentScanError("infected", "The uploaded file was quarantined by malware scanning.");
    }
    if (!response.ok || body.verdict !== "clean" || body.sha256 !== digest) {
      throw new ContentScanError("unavailable", "The document scanner did not return a verified clean result.");
    }
    return {
      verdict: "clean",
      sha256: digest,
      engine: String(body.engine || "ClamAV").slice(0, 80),
      engineResult: String(body.engineResult || "").slice(0, 500) || undefined,
    };
  } catch (error) {
    if (error instanceof ContentScanError) throw error;
    throw new ContentScanError("unavailable", "The document scanner is temporarily unavailable.");
  } finally {
    clearTimeout(timer);
  }
}
