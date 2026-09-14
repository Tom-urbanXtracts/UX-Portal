import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { approvedHttpsUrl } from "../_shared/security-contract.ts";
import { verifiedTokenHasAal2 } from "../_shared/mfa.ts";
// @ts-ignore qrcode is bundled by esm.sh for the Edge runtime; no Node APIs are used here.
import QRCode from "https://esm.sh/qrcode@1.5.4?target=deno&no-dts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ASSET_HOSTS = new Set([
  ...String(Deno.env.get("PORTAL_EXTERNAL_ASSET_HOSTS") ?? "").split(",")
    .map((host) => host.trim().toLowerCase()).filter(Boolean),
  (() => {
    try {
      return new URL(SUPABASE_URL).hostname.toLowerCase();
    } catch {
      return "";
    }
  })(),
].filter(Boolean));
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = { user: Row; profile: Row };

class KioskError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
    "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
    "https://portal.urbanxtracts.com",
    "https://tom-urbanxtracts.github.io",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ]).has(candidate)
    ? candidate
    : "https://portal.urbanxtracts.com";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function actorFor(request: Request): Promise<Actor | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenHasAal2(authorization)) {
    return null;
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) return null;
  const user = await response.json() as Row;
  const { data: profile, error } = await service.from("portal_profile").select(
    "id,full_name,org,role,staff_role,active",
  ).eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (!profile || profile.active === false || profile.role !== "internal") return null;
  const { data: grant, error: grantError } = await service.from(
    "portal_role_permission",
  ).select("permission").eq("staff_role", profile.staff_role).eq(
    "permission",
    "users.manage",
  ).maybeSingle();
  if (grantError) throw grantError;
  return grant ? { user, profile: profile as unknown as Row } : null;
}

async function audit(actor: Actor, action: string, detail: Row): Promise<void> {
  const { error } = await service.from("portal_admin_audit").insert({
    actor_id: actor.profile.id,
    actor_org: actor.profile.org,
    action,
    target_org: detail.organization ?? null,
    detail,
  });
  if (error) throw error;
}

function safeAnalytes(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((entry) => {
    const row = entry && typeof entry === "object" ? entry as Row : {};
    return {
      name: clean(row.name ?? row.analyte ?? row.label, 120),
      value: clean(row.value ?? row.result, 80),
      unit: clean(row.unit ?? row.units, 40),
    };
  }).filter((entry) => entry.name && entry.value);
}

function safeProfile(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Row).slice(0, 30).map(
    ([key, entry]) => [clean(key, 80), clean(entry, 300)],
  ).filter(([key, entry]) => Boolean(key && entry)));
}

function userAgentFamily(value: string): string {
  const ua = value.toLowerCase();
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("chrome/")) return "Chrome";
  if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";
  if (ua.includes("firefox/")) return "Firefox";
  return value ? "Other" : "Not reported";
}

async function resolveKiosk(token: string, requestUserAgentFamily: string): Promise<Row> {
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) {
    throw new KioskError(404, "This kiosk link is invalid or no longer active.");
  }
  const tokenHash = await sha256(token);
  const { data: link, error: linkError } = await service.from(
    "portal_kiosk_link",
  ).select("id,store_license,label,last_used_at,expires_at,allowed_categories,allowed_item_ids,access_count").eq("token_hash", tokenHash)
    .eq("active", true).maybeSingle();
  if (linkError) throw linkError;
  if (!link) throw new KioskError(404, "This kiosk link is invalid or no longer active.");
  if (link.expires_at && new Date(String(link.expires_at)).getTime() <= Date.now()) {
    throw new KioskError(410, "This kiosk link has expired. Ask the store owner for a current link.");
  }

  const { data: store, error: storeError } = await service.from("portal_store")
    .select("display_name,organization,active,license_status")
    .eq("license_number", link.store_license).maybeSingle();
  if (storeError) throw storeError;
  if (!store || store.active === false || store.license_status !== "active") {
    throw new KioskError(410, "This store kiosk is currently unavailable.");
  }

  const { data: content, error: contentError } = await service.from(
    "portal_product_content",
  ).select(
    "canix_item_id,short_description,long_description,selling_points,ingredients,usage_information,product_profile,image_url,keywords,updated_at",
  ).eq("publication_state", "published").order("updated_at", { ascending: false })
    .limit(500);
  if (contentError) throw contentError;
  const itemIds = (content ?? []).map((row) => Number(row.canix_item_id)).filter(
    Number.isSafeInteger,
  );
  const { data: items, error: itemError } = itemIds.length
    ? await service.from("canix_item_current").select(
      "item_id,name,brand_name,item_category_name,item_sub_type_name,sku,strain_name,strain_type,public_ingredients,description",
    ).in("item_id", itemIds).eq("is_active", true)
    : { data: [], error: null };
  if (itemError) throw itemError;
  const itemById = new Map((items ?? []).map((row) => [Number(row.item_id), row]));
  const { data: coaRows, error: coaError } = itemIds.length
    ? await service.from("canix_package_coa").select(
      "canix_item_id,result_status,cannabinoids,terpenes,profile,tested_at,version,document_url",
    ).in("canix_item_id", itemIds).order("tested_at", {
      ascending: false,
      nullsFirst: false,
    }).limit(2000)
    : { data: [], error: null };
  if (coaError) throw coaError;
  const coaByItem = new Map<number, Row>();
  for (const row of coaRows ?? []) {
    const itemId = Number(row.canix_item_id);
    if (!coaByItem.has(itemId)) coaByItem.set(itemId, row as unknown as Row);
  }

  const categoryScope = new Set(Array.isArray(link.allowed_categories)
    ? link.allowed_categories.map((entry: unknown) => clean(entry, 160).toLowerCase()).filter(Boolean)
    : []);
  const itemScope = new Set(Array.isArray(link.allowed_item_ids)
    ? link.allowed_item_ids.map(Number).filter(Number.isSafeInteger)
    : []);
  const products = (content ?? []).map((record) => {
    const itemId = Number(record.canix_item_id);
    const item = itemById.get(itemId);
    if (!item) return null;
    const coa = coaByItem.get(itemId) ?? {};
    const category = clean(item.item_category_name, 160) || "Other";
    if (categoryScope.size && !categoryScope.has(category.toLowerCase())) return null;
    if (itemScope.size && !itemScope.has(itemId)) return null;
    return {
      id: `canix-item-${itemId}`,
      name: clean(item.name, 300) || "Unnamed product",
      brand: clean(item.brand_name, 200) || "Brand not recorded",
      category,
      format: clean(item.item_sub_type_name, 160) || "Product",
      sku: clean(item.sku, 120),
      strain: [clean(item.strain_name, 120), clean(item.strain_type, 80)].filter(Boolean)
        .join(" · "),
      shortDescription: clean(record.short_description ?? item.description, 1000),
      longDescription: clean(record.long_description, 5000),
      sellingPoints: Array.isArray(record.selling_points)
        ? record.selling_points.slice(0, 12).map((entry) => clean(entry, 300)).filter(Boolean)
        : [],
      ingredients: clean(record.ingredients ?? item.public_ingredients, 3000),
      usageInformation: clean(record.usage_information, 3000),
      productProfile: clean(record.product_profile, 3000),
      imageUrl: approvedHttpsUrl(clean(record.image_url, 2000), ASSET_HOSTS),
      keywords: Array.isArray(record.keywords)
        ? record.keywords.slice(0, 40).map((entry) => clean(entry, 100)).filter(Boolean)
        : [],
      coa: {
        available: Boolean(coa.canix_item_id),
        resultStatus: clean(coa.result_status, 120),
        testedAt: clean(coa.tested_at, 80),
        version: Number(coa.version) || null,
        cannabinoids: safeAnalytes(coa.cannabinoids),
        terpenes: safeAnalytes(coa.terpenes),
        profile: safeProfile(coa.profile),
        // A public kiosk reports document availability without exposing a
        // temporary or source-system URL outside authenticated traceability.
        documentAvailable: Boolean(approvedHttpsUrl(clean(coa.document_url, 2000), ASSET_HOSTS)),
      },
    };
  }).filter(Boolean);

  const lastUsed = link.last_used_at ? new Date(String(link.last_used_at)).getTime() : 0;
  if (!lastUsed || Date.now() - lastUsed > 15 * 60 * 1000) {
    await service.from("portal_kiosk_link").update({
      last_used_at: new Date().toISOString(),
      access_count: Number(link.access_count || 0) + 1,
    }).eq("id", link.id).eq("active", true);
    await service.from("portal_kiosk_access_event").insert({
      kiosk_link_id: link.id,
      product_count: products.length,
      user_agent_family: clean(requestUserAgentFamily, 80) || null,
    });
  }
  return {
    store: { name: store.display_name, organization: store.organization },
    label: link.label,
    products,
    generatedAt: new Date().toISOString(),
    capabilities: {
      ordering: false,
      pricing: false,
      quantities: false,
      accounts: false,
      administration: false,
    },
  };
}

async function adminSnapshot(): Promise<Row> {
  const [{ data: stores, error: storesError }, { data: links, error: linksError }] =
    await Promise.all([
      service.from("portal_store").select(
        "license_number,display_name,organization,active,license_status",
      ).eq("active", true).order("organization").order("display_name"),
      service.from("portal_kiosk_link").select(
        "id,store_license,label,device_label,token_prefix,active,created_at,revoked_at,last_used_at,expires_at,allowed_categories,allowed_item_ids,access_count,last_rotated_at,rotated_from_id",
      ).order("created_at", { ascending: false }).limit(500),
    ]);
  if (storesError) throw storesError;
  if (linksError) throw linksError;
  return {
    stores: (stores ?? []).map((store) => ({
      license: store.license_number,
      name: store.display_name,
      organization: store.organization,
      active: store.active !== false && store.license_status === "active",
    })),
    links: links ?? [],
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const body = await request.json().catch(() => ({})) as Row;
    const action = clean(body.action, 40).toLowerCase();
    if (action === "resolve") {
      return json(request, { ok: true, ...(await resolveKiosk(
        clean(body.token, 100),
        userAgentFamily(request.headers.get("user-agent") ?? ""),
      )) });
    }
    const actor = await actorFor(request);
    if (!actor) return json(request, { error: "Forbidden" }, 403);
    if (action === "list") {
      return json(request, { ok: true, ...(await adminSnapshot()) });
    }
    if (action === "create") {
      const storeLicense = clean(body.storeLicense, 120).toUpperCase();
      const label = clean(body.label, 120) || "Budtender kiosk";
      const deviceLabel = clean(body.deviceLabel, 160) || label;
      const expiresInDays = Math.max(1, Math.min(365, Number(body.expiresInDays) || 90));
      const allowedCategories = Array.isArray(body.allowedCategories)
        ? Array.from(new Set(body.allowedCategories.map((entry) => clean(entry, 160)).filter(Boolean))).slice(0, 30)
        : [];
      const allowedItemIds = Array.isArray(body.allowedItemIds)
        ? Array.from(new Set(body.allowedItemIds.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))).slice(0, 500)
        : [];
      const { data: store, error: storeError } = await service.from("portal_store")
        .select("license_number,display_name,organization,active,license_status")
        .eq("license_number", storeLicense).maybeSingle();
      if (storeError) throw storeError;
      if (!store || store.active === false || store.license_status !== "active") {
        throw new KioskError(409, "Choose an active, qualified store.");
      }
      const token = newToken();
      const { data: link, error } = await service.from("portal_kiosk_link")
        .insert({
          store_license: storeLicense,
          label,
          device_label: deviceLabel,
          token_hash: await sha256(token),
          token_prefix: token.slice(0, 8),
          expires_at: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
          allowed_categories: allowedCategories,
          allowed_item_ids: allowedItemIds,
          created_by: actor.profile.id,
        }).select("id,store_license,label,device_label,token_prefix,active,created_at,expires_at,allowed_categories,allowed_item_ids,access_count").single();
      if (error) throw error;
      await audit(actor, "kiosk-link-created", {
        kioskLinkId: link.id,
        storeLicense,
        storeName: store.display_name,
        organization: store.organization,
        expiresInDays,
        categoryRestrictionCount: allowedCategories.length,
        itemRestrictionCount: allowedItemIds.length,
      });
      const kioskUrl = `https://portal.urbanxtracts.com/#kiosk=${token}`;
      return json(request, {
        ok: true,
        link,
        token,
        kioskUrl,
        qrSvg: await QRCode.toString(kioskUrl, {
          type: "svg",
          errorCorrectionLevel: "M",
          margin: 1,
          width: 320,
        }),
        ...(await adminSnapshot()),
      }, 201);
    }
    if (action === "rotate") {
      const linkId = clean(body.linkId, 80);
      const { data: existing, error: existingError } = await service.from(
        "portal_kiosk_link",
      ).select("*").eq("id", linkId).eq("active", true).maybeSingle();
      if (existingError) throw existingError;
      if (!existing) throw new KioskError(404, "Active kiosk link not found.");
      const token = newToken();
      const now = new Date().toISOString();
      const expiresInDays = Math.max(1, Math.min(365, Number(body.expiresInDays) || 90));
      const { data: created, error: createError } = await service.from("portal_kiosk_link").insert({
        store_license: existing.store_license,
        label: existing.label,
        device_label: existing.device_label,
        token_hash: await sha256(token),
        token_prefix: token.slice(0, 8),
        expires_at: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
        allowed_categories: existing.allowed_categories ?? [],
        allowed_item_ids: existing.allowed_item_ids ?? [],
        rotated_from_id: existing.id,
        last_rotated_at: now,
        created_by: actor.profile.id,
      }).select("id,store_license,label,device_label,token_prefix,active,created_at,expires_at,allowed_categories,allowed_item_ids,access_count").single();
      if (createError) throw createError;
      const { error: revokeError } = await service.from("portal_kiosk_link").update({
        active: false,
        revoked_by: actor.profile.id,
        revoked_at: now,
        last_rotated_at: now,
      }).eq("id", existing.id).eq("active", true);
      if (revokeError) {
        await service.from("portal_kiosk_link").delete().eq("id", created.id);
        throw revokeError;
      }
      await audit(actor, "kiosk-link-rotated", {
        kioskLinkId: existing.id,
        replacementLinkId: created.id,
        storeLicense: existing.store_license,
      });
      const kioskUrl = `https://portal.urbanxtracts.com/#kiosk=${token}`;
      return json(request, {
        ok: true,
        link: created,
        token,
        kioskUrl,
        qrSvg: await QRCode.toString(kioskUrl, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 320 }),
        ...(await adminSnapshot()),
      });
    }
    if (action === "revoke") {
      const linkId = clean(body.linkId, 80);
      const { data: existing, error: existingError } = await service.from(
        "portal_kiosk_link",
      ).select("id,store_license,label,active").eq("id", linkId).maybeSingle();
      if (existingError) throw existingError;
      if (!existing) throw new KioskError(404, "Kiosk link not found.");
      if (existing.active) {
        const { error } = await service.from("portal_kiosk_link").update({
          active: false,
          revoked_by: actor.profile.id,
          revoked_at: new Date().toISOString(),
        }).eq("id", linkId).eq("active", true);
        if (error) throw error;
        await audit(actor, "kiosk-link-revoked", {
          kioskLinkId: linkId,
          storeLicense: existing.store_license,
          label: existing.label,
        });
      }
      return json(request, { ok: true, ...(await adminSnapshot()) });
    }
    throw new KioskError(400, "Unsupported kiosk action.");
  } catch (error) {
    if (!(error instanceof KioskError)) console.error("portal-kiosk", error);
    return json(request, {
      error: error instanceof KioskError
        ? error.message
        : "The kiosk service is temporarily unavailable.",
    }, error instanceof KioskError ? error.status : 500);
  }
});
