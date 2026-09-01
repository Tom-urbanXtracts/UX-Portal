import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const sourcePortalPath = resolve(projectRoot, "ux-portal-prototype.dc.html");
const portalPath = resolve(projectRoot, "dist/portal.html");
const inventoryPath = resolve(projectRoot, "data/canix-inventory-snapshot.json");
const outputDir = resolve(projectRoot, "dist/server");
const outputPath = resolve(outputDir, "index.js");
const sourcePortalHtml = await readFile(sourcePortalPath, "utf8");
const packedPortalHtml = (await readFile(portalPath, "utf8")).replace(
  "const MONEY = c => '</script>\n</body>\n</html> + (c",
  "const MONEY = c => '$' + (c",
);
const inventoryJson = await readFile(inventoryPath, "utf8");
const inventory = JSON.parse(inventoryJson);
const quantityTypes = inventory?.scope?.quantity_types;
if (!Array.isArray(quantityTypes) || quantityTypes.length !== 2 || !quantityTypes.includes("WeightBased") || !quantityTypes.includes("CountBased")) {
  throw new Error("Inventory snapshot must contain only WeightBased and CountBased data.");
}
if (!Array.isArray(inventory.package_columns) || !Array.isArray(inventory.packages) || inventory.packages.some(row => !Array.isArray(row) || row.length !== inventory.package_columns.length)) {
  throw new Error("Inventory snapshot package rows do not match the declared package schema.");
}

const sourceDcScript = sourcePortalHtml.match(/<script\b[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
const packedTemplateMatch = packedPortalHtml.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
if (!sourceDcScript || !packedTemplateMatch) {
  throw new Error("Portal source or packed template is missing its application script.");
}

const packedTemplate = JSON.parse(packedTemplateMatch[1]);
const packedDcScriptPattern = /(<script\b[^>]*\bdata-dc-script\b[^>]*>)[\s\S]*?(<\/script>)/;
if (!packedDcScriptPattern.test(packedTemplate)) {
  throw new Error("Packed portal template is missing its application script.");
}

const updatedTemplate = packedTemplate.replace(
  packedDcScriptPattern,
  (_, openTag, closeTag) => `${openTag}${sourceDcScript}${closeTag}`,
);
const serializedTemplate = JSON.stringify(updatedTemplate).replace(/<\//g, "<\\u002F");
const portalHtml = packedPortalHtml.replace(packedTemplateMatch[1], () => serializedTemplate);
await writeFile(portalPath, portalHtml);

const worker = `const PORTAL_HTML = ${JSON.stringify(portalHtml)};
const INVENTORY_JSON = ${JSON.stringify(inventoryJson)};

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
    if (url.pathname === "/api/inventory") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return new Response(request.method === "HEAD" ? null : INVENTORY_JSON, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
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
