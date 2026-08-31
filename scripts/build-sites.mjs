import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const portalPath = resolve(projectRoot, "dist/portal.html");
const outputDir = resolve(projectRoot, "dist/server");
const outputPath = resolve(outputDir, "index.js");
const portalHtml = await readFile(portalPath, "utf8");

const worker = `const PORTAL_HTML = ${JSON.stringify(portalHtml)};

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "SAMEORIGIN",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const allowedPath = url.pathname === "/" || url.pathname === "/portal" || url.pathname === "/dist/portal.html";

    if (!allowedPath) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    return new Response(request.method === "HEAD" ? null : PORTAL_HTML, {
      status: 200,
      headers: HTML_HEADERS,
    });
  },
};
`;

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, worker);
console.log(`Built ${outputPath}`);
