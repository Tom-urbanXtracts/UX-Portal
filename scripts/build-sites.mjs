import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const sourcePortalPath = resolve(projectRoot, "ux-portal-prototype.dc.html");
const portalPath = resolve(projectRoot, "dist/portal.html");
const outputDir = resolve(projectRoot, "dist/server");
const outputPath = resolve(outputDir, "index.js");
const sourcePortalHtml = await readFile(sourcePortalPath, "utf8");
const packedPortalHtml = (await readFile(portalPath, "utf8"))
  .replace(
    "const MONEY = c => '</script>\n</body>\n</html> + (c",
    "const MONEY = c => '$' + (c",
  )
  .replaceAll("urbanXtracts Wholesale Portal — prototype", "urbanXtracts Wholesale Portal")
  .replace(
    "Design prototype for the urbanXtracts wholesale portal. Not a product build; all commercial values are synthetic.",
    "Private ordering and inventory portal for urbanXtracts and its licensed retail partners.",
  )
  .replace(
    "Design prototype. Not a product build; all commercial values are synthetic.",
    "Private ordering and inventory portal for licensed retail partners.",
  );
const packedTemplateMatch = packedPortalHtml.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
if (!packedTemplateMatch) {
  throw new Error("Portal source or packed template is missing its application script.");
}

const packedTemplate = JSON.parse(packedTemplateMatch[1]);
const sourceBody = sourcePortalHtml.match(/<body>([\s\S]*?)<\/body>/)?.[1];
const packedPrefix = packedTemplate.match(/^([\s\S]*?<body>)/)?.[1];
const packedHelmet = packedTemplate.match(/<helmet>[\s\S]*?<\/helmet>/)?.[0];
const blackMark = packedTemplate.match(/<img src="([^"]+)" alt="urbanXtracts" style="height:28px/)?.[1];
const reversedMark = packedTemplate.match(/<img src="([^"]+)" alt="" style="height:46px/)?.[1];
if (!sourceBody || !packedPrefix || !packedHelmet || !blackMark || !reversedMark) {
  throw new Error("The source body or bundled portal resources could not be resolved.");
}

// Sites bundles the runtime, design-system CSS, fonts and brand images into
// opaque resources. Rebuild the application body from source on every build,
// then restore those bundled resource references. This keeps template changes
// and application logic in lockstep instead of updating only the JS payload.
const updatedBody = sourceBody
  .replace(/<helmet>[\s\S]*?<\/helmet>/, packedHelmet)
  .replaceAll('src="brand/ux-mark.png"', `src="${blackMark}"`)
  .replaceAll('src="brand/ux-mark-reversed.png"', `src="${reversedMark}"`);
const updatedTemplate = `${packedPrefix}${updatedBody}</body></html>`;
const serializedTemplate = JSON.stringify(updatedTemplate).replace(/<\//g, "<\\u002F");
const portalHtml = packedPortalHtml.replace(packedTemplateMatch[1], () => serializedTemplate);
await writeFile(portalPath, portalHtml);

const worker = `const PORTAL_HTML = ${JSON.stringify(portalHtml)};

function configuredPortalHtml(env = {}) {
  const provider = env.UX_SSO_PROVIDER === "google" || env.UX_SSO_PROVIDER === "azure"
    ? env.UX_SSO_PROVIDER
    : "";
  const config = {
    ssoProvider: provider,
    ssoDomain: String(env.UX_SSO_DOMAIN || "urbanxtracts.com").toLowerCase(),
    recallNoticeEnabled: env.UX_RECALL_NOTICE_ENABLED === "true",
    turnstileRequired: env.UX_TURNSTILE_REQUIRED === "true",
    turnstileSiteKey: String(env.UX_TURNSTILE_SITE_KEY || ""),
  };
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c");
  return PORTAL_HTML.replace("</head>", "<script>window.UX_PORTAL_CONFIG=" + serialized + ";</" + "script></head>");
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'self' blob: data:; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; connect-src 'self' https://cbhsavfbtcpdyxcvguay.supabase.co https://api.pwnedpasswords.com; frame-src https://challenges.cloudflare.com; img-src 'self' blob: data: https:; font-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://challenges.cloudflare.com",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const allowedPath = url.pathname === "/" || url.pathname === "/portal" || url.pathname === "/dist/portal.html";

    if (!allowedPath) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    return new Response(request.method === "HEAD" ? null : configuredPortalHtml(env), {
      status: 200,
      headers: HTML_HEADERS,
    });
  },
};
`;

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, worker);
console.log(`Built ${outputPath}`);
