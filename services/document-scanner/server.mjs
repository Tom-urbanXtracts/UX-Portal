import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || "8080");
const MAX_BYTES = Math.min(
  25 * 1024 * 1024,
  Math.max(1, Number(process.env.SCANNER_MAX_BYTES || 20 * 1024 * 1024)),
);
const TIMEOUT_MS = Math.min(
  60_000,
  Math.max(1_000, Number(process.env.SCANNER_TIMEOUT_MS || 25_000)),
);
const BINARY = process.env.SCANNER_BINARY || "clamscan";

function reply(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  const expected = String(process.env.SCANNER_SHARED_SECRET || "");
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function readBody(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > MAX_BYTES) throw Object.assign(new Error("File exceeds scanner limit."), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BYTES) throw Object.assign(new Error("File exceeds scanner limit."), { status: 413 });
    chunks.push(chunk);
  }
  if (!total) throw Object.assign(new Error("A file body is required."), { status: 400 });
  return Buffer.concat(chunks, total);
}

export function scanBuffer(bytes, options = {}) {
  const binary = options.binary || BINARY;
  const args = options.args || ["--stdout", "--no-summary", "-"];
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(Object.assign(new Error("Scanner timed out."), { code: "SCAN_TIMEOUT" })));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
      if (code === 0) return resolve({ clean: true, engineResult: output || "stdin: OK" });
      if (code === 1) return resolve({ clean: false, engineResult: output || "Threat detected" });
      return reject(Object.assign(new Error(diagnostic || `Scanner exited with code ${code}.`), { code: "SCAN_FAILED" }));
    }));
    child.stdin.end(bytes);
  });
}

export function scannerServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return reply(response, 200, { status: "ready", engine: "ClamAV" });
      }
      if (request.method !== "POST" || request.url !== "/scan") {
        return reply(response, 404, { error: "Not found" });
      }
      if (!authorized(request)) return reply(response, 401, { error: "Unauthorized" });
      const bytes = await readBody(request);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const expectedSha = String(request.headers["x-content-sha256"] || "").toLowerCase();
      if (expectedSha && expectedSha !== sha256) {
        return reply(response, 409, { error: "Content digest mismatch." });
      }
      const result = await scanBuffer(bytes);
      return reply(response, result.clean ? 200 : 422, {
        verdict: result.clean ? "clean" : "infected",
        sha256,
        engine: "ClamAV",
        engineResult: result.engineResult,
      });
    } catch (error) {
      const status = Number(error?.status) || 503;
      return reply(response, status, {
        error: status === 503 ? "The malware scanner is temporarily unavailable." : String(error.message || error),
      });
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  scannerServer().listen(PORT, "0.0.0.0");
}
