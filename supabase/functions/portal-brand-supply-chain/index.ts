import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";
import { ContentScanError, scanContent, sha256Hex } from "../_shared/content-scanner.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "portal-brand-supply-documents";
const ALLOWED_ORIGINS = new Set([
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
  "https://portal.urbanxtracts.com",
  "https://tom-urbanxtracts.github.io",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const ENTITY_TYPES = new Set(["sku", "vendor", "component", "marketplace_product"]);
const VENDOR_DOCUMENTS = new Set([
  "gmp_haccp", "iso_certification", "w9", "business_license", "other",
]);
const SKU_DOCUMENTS = new Set([
  "marketing_image", "packaging_photo", "label_photo", "label_print_file",
  "product_quality_plan", "sop", "work_instructions",
  "manufacturing_batch_record", "master_manufacturing_plan", "other",
]);
const COMPONENT_DOCUMENTS: Record<string, Set<string>> = {
  ingredient: new Set([
    "certificate_of_compliance", "food_grade", "allergen_statement",
    "origin_traceability", "kosher_halal", "sds", "coa", "other",
  ]),
  packaging: new Set([
    "certificate_of_compliance", "child_resistance", "tamper_evident",
    "sustainability", "other",
  ]),
  hardware: new Set([
    "certificate_of_compliance", "food_contact_safety", "heavy_metals",
    "battery_safety", "engineering_diagram", "letter_of_guarantee", "sds", "other",
  ]),
};

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = {
  user: Row;
  profile: Row;
  organization: Row;
  membership: Row | null;
  internal: boolean;
  canContribute: boolean;
  canArchive: boolean;
};

class SupplyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  ).trim().slice(0, max);
}

function nullable(value: unknown, max = 500): string | null {
  return clean(value, max) || null;
}

function uuidValue(value: unknown, label: string): string {
  const candidate = clean(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    throw new SupplyError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

function origin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return ALLOWED_ORIGINS.has(candidate) ? candidate : "https://portal.urbanxtracts.com";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": origin(request),
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

function actorEmail(actor: Actor): string {
  return clean(actor.user.email || actor.profile.full_name, 320).toLowerCase();
}

async function actorFor(request: Request, organizationId: string): Promise<Actor> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenIsAuthenticated(authorization)) {
    throw new SupplyError(403, "Forbidden");
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) throw new SupplyError(403, "Forbidden");
  const user = await response.json() as Row;
  const { data: profile, error: profileError } = await service.from("portal_profile")
    .select("id,full_name,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.active === false) throw new SupplyError(403, "Forbidden");
  const { data: organization, error: organizationError } = await service
    .from("portal_organization").select("id,kind,legal_name,display_name,status")
    .eq("id", organizationId).eq("kind", "brand").maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new SupplyError(404, "Brand organization not found.");

  if (profile.role === "internal" && profile.staff_role === "administrator") {
    return {
      user,
      profile: profile as Row,
      organization: organization as Row,
      membership: null,
      internal: true,
      canContribute: true,
      canArchive: true,
    };
  }
  if (profile.role !== "brand") throw new SupplyError(403, "Forbidden");
  const { data: membership, error: membershipError } = await service
    .from("portal_organization_membership").select("id,member_role,status")
    .eq("profile_id", profile.id).eq("organization_id", organizationId)
    .eq("workspace", "brand").eq("status", "active").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new SupplyError(403, "This Brand is outside your access scope.");
  const { data: permissions, error: permissionError } = await service
    .from("portal_workspace_role_permission").select("permission")
    .eq("workspace", "brand").eq("member_role", membership.member_role)
    .in("permission", [
      "brand.products.read", "brand.products.contribute",
      "brand.documents.read", "brand.documents.contribute",
    ]);
  if (permissionError) throw permissionError;
  const grants = new Set((permissions ?? []).map((row) => String(row.permission)));
  if (!grants.has("brand.products.read") || !grants.has("brand.documents.read")) {
    throw new SupplyError(403, "Your Brand role cannot read product records.");
  }
  return {
    user,
    profile: profile as Row,
    organization: organization as Row,
    membership: membership as Row,
    internal: false,
    // SKU intake, vendor qualification, and component records are Internal-only.
    // Brand members may read finished-goods catalog documents, but cannot mutate
    // the underlying product workflow through direct API calls.
    canContribute: false,
    canArchive: false,
  };
}

async function logEvent(actor: Actor, action: string, targetType: string, targetId: string | null, detail: Row): Promise<void> {
  const { error } = await service.from("portal_brand_operation_event").insert({
    organization_id: actor.organization.id,
    actor_id: actor.user.id,
    actor_email: actorEmail(actor),
    action,
    target_type: targetType,
    target_id: targetId,
    detail,
  });
  if (error) throw error;
}

function normalizedIdentity(value: unknown): string {
  return clean(value, 500).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function brandVisibleFinishedGood(row: Row): boolean {
  const description = [row.product_name, row.productName, row.item_category_name, row.category]
    .filter(Boolean).join(" ");
  return !/\b(?:clone|biomass|seeds?|oil|rosin|bulk|plant material)\b/i.test(description);
}

async function marketplaceProductsFor(actor: Actor): Promise<Row[]> {
  const { data: account, error: accountError } = await service.from("portal_brand_account")
    .select("canix_brand_id,canix_brand_name").eq("organization_id", actor.organization.id).maybeSingle();
  if (accountError) throw accountError;
  const mappedBrandId = clean(account?.canix_brand_id, 40);
  const mappedBrandName = normalizedIdentity(account?.canix_brand_name);
  if (!mappedBrandId && !mappedBrandName) return [];
  const { data: state, error: stateError } = await service.from("canix_marketplace_sync_state")
    .select("last_successful_run_id").eq("id", 1).maybeSingle();
  if (stateError) throw stateError;
  if (!state?.last_successful_run_id) return [];
  const { data, error } = await service.from("canix_marketplace_product_snapshot").select(
    "marketplace_product_id,product_gid,product_name,brand_id,brand_name,item_category_name,price_cents,sale_unit,has_image,image_url,synced_at",
  ).eq("sync_run_id", state.last_successful_run_id).order("product_name");
  if (error) throw error;
  return ((data ?? []) as Row[]).filter((row) => {
    const rowBrandId = clean(row.brand_id, 40);
    const idMatches = !!mappedBrandId && !!rowBrandId && mappedBrandId === rowBrandId;
    const nameMatches = !!mappedBrandName && normalizedIdentity(row.brand_name) === mappedBrandName;
    return (idMatches || nameMatches) && (actor.internal || brandVisibleFinishedGood(row));
  }).map((row) => ({
    id: clean(row.marketplace_product_id, 80),
    productName: clean(row.product_name, 300) || "Unnamed Canix product",
    brandName: clean(row.brand_name, 200) || null,
    category: clean(row.item_category_name, 160) || "Not classified",
    productGid: clean(row.product_gid, 1000) || null,
    priceCents: row.price_cents,
    saleUnit: clean(row.sale_unit, 80) || null,
    imageUrl: row.has_image ? row.image_url : null,
    syncedAt: row.synced_at,
  })).filter((row) => row.id);
}

async function snapshotFor(actor: Actor): Promise<Row> {
  const organizationId = String(actor.organization.id);
  const [skuResult, vendorResult, componentResult, marketplaceProducts] = await Promise.all([
    service.from("portal_sku_intake")
      .select("id,reference,brand_name,product_name,status,updated_at")
      .eq("organization_id", organizationId).neq("status", "archived")
      .order("updated_at", { ascending: false }),
    service.from("portal_brand_vendor").select("*")
      .eq("organization_id", organizationId).neq("status", "archived")
      .order("updated_at", { ascending: false }),
    service.from("portal_brand_component").select("*")
      .eq("organization_id", organizationId).neq("status", "archived")
      .order("updated_at", { ascending: false }),
    marketplaceProductsFor(actor),
  ]);
  if (skuResult.error) throw skuResult.error;
  if (vendorResult.error) throw vendorResult.error;
  if (componentResult.error) throw componentResult.error;
  let documentQuery = service.from("portal_brand_supply_document").select(
    "id,entity_type,entity_id,source_product_id,source_product_name,linked_sku_intake_id,document_state,approved_by_email,approved_at,document_type,title,visibility,status,notes,original_name,content_type,size_bytes,uploaded_by_email,created_at,updated_at",
  ).eq("organization_id", organizationId).order("created_at", { ascending: false });
  if (!actor.internal) documentQuery = documentQuery.eq("visibility", "brand_and_internal");
  const { data: documents, error: documentError } = await documentQuery;
  if (documentError) throw documentError;
  const internalSkus = skuResult.data ?? [];
  const internalVendors = vendorResult.data ?? [];
  const internalComponents = componentResult.data ?? [];
  return {
    organization: actor.organization,
    skus: actor.internal ? internalSkus : [],
    vendors: actor.internal ? internalVendors : [],
    components: actor.internal ? internalComponents : [],
    marketplaceProducts,
    documents: documents ?? [],
    documentTypes: {
      sku: [...SKU_DOCUMENTS],
      marketplace_product: [...SKU_DOCUMENTS],
      vendor: [...VENDOR_DOCUMENTS],
      ingredient: [...COMPONENT_DOCUMENTS.ingredient],
      packaging: [...COMPONENT_DOCUMENTS.packaging],
      hardware: [...COMPONENT_DOCUMENTS.hardware],
    },
    capabilities: {
      canContribute: actor.internal && actor.canContribute,
      canReview: actor.internal,
      canArchive: actor.canArchive,
      canSetInternalVisibility: actor.internal,
      canApproveCatalogDocuments: actor.internal,
    },
    catalogLinkQueue: marketplaceProducts.map((product) => {
      const productDocuments = (documents ?? []).filter((document) =>
        document.entity_type === "marketplace_product" &&
        String(document.source_product_id) === String(product.id) &&
        document.status === "current"
      );
      return {
        ...product,
        documentCount: productDocuments.length,
        pendingCount: productDocuments.filter((document) => document.document_state === "pending_sku_link").length,
        approvedCount: productDocuments.filter((document) => document.document_state === "approved_sku_document").length,
      };
    }).filter((product) => Number(product.documentCount) > 0),
  };
}

function writableStatus(actor: Actor, row: Row): void {
  if (!actor.canContribute) throw new SupplyError(403, "Your role cannot change product records.");
  if (!actor.internal && ["in_review", "approved"].includes(String(row.status))) {
    throw new SupplyError(409, "This record is locked for Internal review.");
  }
}

async function saveVendor(actor: Actor, body: Row): Promise<void> {
  if (!actor.canContribute) throw new SupplyError(403, "Your role cannot save vendors.");
  const id = clean(body.vendorId, 80);
  const legalName = clean(body.legalBusinessName, 240);
  if (!legalName) throw new SupplyError(400, "Enter the vendor legal business name.");
  let existing: Row | null = null;
  if (id) {
    const { data, error } = await service.from("portal_brand_vendor").select("*")
      .eq("id", uuidValue(id, "vendor")).eq("organization_id", actor.organization.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new SupplyError(404, "Vendor not found.");
    existing = data as Row;
    writableStatus(actor, existing);
  }
  const values = {
    organization_id: actor.organization.id,
    legal_business_name: legalName,
    dba_name: nullable(body.dbaName, 240),
    main_contact_name: nullable(body.mainContactName, 240),
    main_contact_email: nullable(body.mainContactEmail, 320)?.toLowerCase() ?? null,
    main_contact_phone: nullable(body.mainContactPhone, 80),
    business_address: nullable(body.businessAddress, 1200),
    shipping_address: nullable(body.shippingAddress, 1200),
    status: existing?.status === "changes_requested" ? "draft" : String(existing?.status ?? "draft"),
    review_note: existing?.status === "changes_requested" ? null : existing?.review_note ?? null,
    revision: Number(existing?.revision ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    const { error } = await service.from("portal_brand_vendor").update(values)
      .eq("id", existing.id).eq("organization_id", actor.organization.id);
    if (error) throw error;
    await logEvent(actor, "brand-vendor-draft-saved", "brand_vendor", String(existing.id), { legalName });
  } else {
    const { data, error } = await service.from("portal_brand_vendor").insert({
      ...values,
      created_by: actor.user.id,
      created_by_email: actorEmail(actor),
    }).select("id").single();
    if (error) throw error;
    await logEvent(actor, "brand-vendor-created", "brand_vendor", String(data.id), { legalName });
  }
}

async function saveComponent(actor: Actor, body: Row): Promise<void> {
  if (!actor.canContribute) throw new SupplyError(403, "Your role cannot save components.");
  const id = clean(body.componentId, 80);
  const skuId = uuidValue(body.skuId, "SKU packet");
  const componentType = clean(body.componentType, 40).toLowerCase();
  if (!COMPONENT_DOCUMENTS[componentType]) throw new SupplyError(400, "Choose ingredient, packaging, or hardware.");
  const name = clean(body.name, 240);
  if (!name) throw new SupplyError(400, "Enter the component name.");
  const { data: sku, error: skuError } = await service.from("portal_sku_intake").select("id")
    .eq("id", skuId).eq("organization_id", actor.organization.id).maybeSingle();
  if (skuError) throw skuError;
  if (!sku) throw new SupplyError(404, "SKU packet not found in this Brand.");
  let vendorId: string | null = null;
  if (clean(body.vendorId, 80)) {
    vendorId = uuidValue(body.vendorId, "vendor");
    const { data: vendor, error } = await service.from("portal_brand_vendor").select("id")
      .eq("id", vendorId).eq("organization_id", actor.organization.id).maybeSingle();
    if (error) throw error;
    if (!vendor) throw new SupplyError(404, "Vendor not found in this Brand.");
  }
  let existing: Row | null = null;
  if (id) {
    const { data, error } = await service.from("portal_brand_component").select("*")
      .eq("id", uuidValue(id, "component")).eq("organization_id", actor.organization.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new SupplyError(404, "Component not found.");
    existing = data as Row;
    writableStatus(actor, existing);
  }
  const amount = clean(body.amountPerUnit, 40);
  if (amount && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    throw new SupplyError(400, "Amount per finished unit must be greater than zero.");
  }
  const values = {
    organization_id: actor.organization.id,
    sku_intake_id: skuId,
    vendor_id: vendorId,
    component_type: componentType,
    name,
    manufacturer_name: nullable(body.manufacturerName, 240),
    item_code: nullable(body.itemCode, 120),
    amount_per_unit: amount ? Number(amount) : null,
    amount_uom: nullable(body.amountUom, 80),
    specification: nullable(body.specification, 4000),
    inventory_class: ["cannabis", "non_cannabis", "not_inventory"].includes(clean(body.inventoryClass, 40))
      ? clean(body.inventoryClass, 40) : "unclassified",
    status: existing?.status === "changes_requested" ? "draft" : String(existing?.status ?? "draft"),
    review_note: existing?.status === "changes_requested" ? null : existing?.review_note ?? null,
    revision: Number(existing?.revision ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    const { error } = await service.from("portal_brand_component").update(values)
      .eq("id", existing.id).eq("organization_id", actor.organization.id);
    if (error) throw error;
    await logEvent(actor, "brand-component-draft-saved", "brand_component", String(existing.id), { name, componentType });
  } else {
    const { data, error } = await service.from("portal_brand_component").insert({
      ...values,
      created_by: actor.user.id,
      created_by_email: actorEmail(actor),
    }).select("id").single();
    if (error) throw error;
    await logEvent(actor, "brand-component-created", "brand_component", String(data.id), { name, componentType });
  }
}

async function submitRecord(actor: Actor, entityType: string, entityId: string): Promise<void> {
  if (!actor.canContribute) throw new SupplyError(403, "Your role cannot submit this record.");
  const table = entityType === "vendor" ? "portal_brand_vendor" : entityType === "component" ? "portal_brand_component" : "";
  if (!table) throw new SupplyError(400, "Choose a vendor or component record.");
  const { data, error } = await service.from(table).select("*").eq("id", entityId)
    .eq("organization_id", actor.organization.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new SupplyError(404, "Record not found.");
  writableStatus(actor, data as Row);
  if (entityType === "vendor") {
    const missing = ["main_contact_name", "main_contact_email", "business_address", "shipping_address"]
      .filter((key) => !clean((data as Row)[key]));
    if (missing.length) throw new SupplyError(409, "Complete contact name, contact email, business address, and shipping address before submission.");
  } else {
    const row = data as Row;
    if (!clean(row.manufacturer_name) && !clean(row.vendor_id)) {
      throw new SupplyError(409, "Choose a vendor or enter the manufacturer name before submission.");
    }
    if (!Number(row.amount_per_unit) || !clean(row.amount_uom) || !clean(row.specification)) {
      throw new SupplyError(409, "Complete amount per finished unit, unit of measure, and specification before submission.");
    }
  }
  const now = new Date().toISOString();
  const { error: updateError } = await service.from(table).update({
    status: "in_review",
    submitted_at: now,
    review_note: null,
    revision: Number((data as Row).revision ?? 0) + 1,
    updated_at: now,
  }).eq("id", entityId).eq("organization_id", actor.organization.id);
  if (updateError) throw updateError;
  await logEvent(actor, `brand-${entityType}-submitted`, `brand_${entityType}`, entityId, {});
}

async function reviewRecord(actor: Actor, body: Row): Promise<void> {
  if (!actor.internal) throw new SupplyError(403, "Only an Internal administrator can make review decisions.");
  const entityType = clean(body.entityType, 40);
  const table = entityType === "vendor" ? "portal_brand_vendor" : entityType === "component" ? "portal_brand_component" : "";
  if (!table) throw new SupplyError(400, "Choose a vendor or component record.");
  const entityId = uuidValue(body.entityId, entityType);
  const decision = clean(body.decision, 40);
  if (!["approve", "request_changes", "reopen"].includes(decision)) throw new SupplyError(400, "Choose a review decision.");
  const note = clean(body.note, 4000);
  if (decision !== "approve" && !note) throw new SupplyError(400, "Enter a review note.");
  const { data, error } = await service.from(table).select("status,revision").eq("id", entityId)
    .eq("organization_id", actor.organization.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new SupplyError(404, "Record not found.");
  if (decision !== "reopen" && data.status !== "in_review") throw new SupplyError(409, "Only submitted records can be reviewed.");
  if (decision === "reopen" && data.status !== "approved") throw new SupplyError(409, "Only approved records can be reopened.");
  const now = new Date().toISOString();
  const status = decision === "approve" ? "approved" : "changes_requested";
  const { error: updateError } = await service.from(table).update({
    status,
    review_note: note || null,
    reviewed_by: actor.user.id,
    reviewed_by_email: actorEmail(actor),
    reviewed_at: now,
    revision: Number(data.revision ?? 0) + 1,
    updated_at: now,
  }).eq("id", entityId).eq("organization_id", actor.organization.id);
  if (updateError) throw updateError;
  await logEvent(actor, `brand-${entityType}-${decision}`, `brand_${entityType}`, entityId, { note });
}

async function entityFor(actor: Actor, entityType: string, entityId: string): Promise<Row> {
  if (!ENTITY_TYPES.has(entityType)) throw new SupplyError(400, "Choose a document record type.");
  if (entityType === "marketplace_product") {
    const product = (await marketplaceProductsFor(actor)).find((row) => String(row.id) === entityId);
    if (!product) throw new SupplyError(404, "The selected Canix catalog product is outside this Brand.");
    return product;
  }
  const table = entityType === "sku" ? "portal_sku_intake" : entityType === "vendor" ? "portal_brand_vendor" : "portal_brand_component";
  const { data, error } = await service.from(table).select("*").eq("id", entityId)
    .eq("organization_id", actor.organization.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new SupplyError(404, "The selected record is outside this Brand.");
  return data as Row;
}

function decodeFile(file: Row): { bytes: Uint8Array; contentType: string; name: string } {
  const encoded = clean(file.base64, 15_000_000);
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new SupplyError(400, "The document could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const declared = Number(file.sizeBytes || 0);
  if (!declared || declared !== bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) {
    throw new SupplyError(400, "Documents must be 10 MB or smaller.");
  }
  const contentType = clean(file.contentType, 120).toLowerCase();
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!((contentType === "application/pdf" && pdf) || (contentType === "image/png" && png) || (contentType === "image/jpeg" && jpeg))) {
    throw new SupplyError(400, "Use a PDF, PNG, or JPEG whose contents match its file type.");
  }
  return { bytes, contentType, name: clean(file.name, 240) || "document" };
}

function extensionFor(contentType: string): string {
  return contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
}

function safeName(value: unknown, fallback: string): string {
  return clean(value, 180).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim() || fallback;
}

function allowedDocumentTypes(entityType: string, entity: Row): Set<string> {
  if (entityType === "sku" || entityType === "marketplace_product") return SKU_DOCUMENTS;
  if (entityType === "vendor") return VENDOR_DOCUMENTS;
  return COMPONENT_DOCUMENTS[String(entity.component_type)] ?? new Set();
}

async function uploadDocument(actor: Actor, body: Row): Promise<void> {
  if (!actor.canContribute) throw new SupplyError(403, "Your role cannot add documents.");
  const entityType = clean(body.entityType, 40).toLowerCase();
  const rawEntityId = clean(body.entityId, 100);
  const entityId = entityType === "marketplace_product"
    ? rawEntityId : uuidValue(rawEntityId, "document record");
  if (!entityId) throw new SupplyError(400, "Choose a document record.");
  const entity = await entityFor(actor, entityType, entityId);
  const documentType = clean(body.documentType, 80).toLowerCase();
  if (!allowedDocumentTypes(entityType, entity).has(documentType)) throw new SupplyError(400, "Choose a valid document type.");
  const title = clean(body.title, 240) || clean((body.file as Row | undefined)?.name, 240);
  if (!title) throw new SupplyError(400, "Enter a document title.");
  const requestedVisibility = clean(body.visibility, 40);
  const visibility = actor.internal && requestedVisibility === "internal_only" ? "internal_only" : "brand_and_internal";
  const { bytes, contentType, name } = decodeFile(body.file && typeof body.file === "object" ? body.file as Row : {});
  const digest = await sha256Hex(bytes);
  let scan;
  try {
    scan = await scanContent(bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError && error.verdict === "infected") {
      throw new SupplyError(422, "The document was blocked by malware scanning.");
    }
    throw new SupplyError(503, "The document scanner is unavailable. Nothing was stored.");
  }
  let duplicateQuery = service.from("portal_brand_supply_document")
    .select("id").eq("organization_id", actor.organization.id).eq("entity_type", entityType)
    .eq("document_type", documentType).eq("sha256", digest);
  duplicateQuery = entityType === "marketplace_product"
    ? duplicateQuery.eq("source_product_id", entityId)
    : duplicateQuery.eq("entity_id", entityId);
  const { data: duplicate, error: duplicateError } = await duplicateQuery.maybeSingle();
  if (duplicateError) throw duplicateError;
  if (duplicate) throw new SupplyError(409, "This exact document is already attached.");
  const objectPath = `${actor.organization.id}/${entityType}/${entityId}/${documentType}/${digest}.${extensionFor(contentType)}`;
  const { error: uploadError } = await service.storage.from(BUCKET).upload(objectPath, bytes, {
    contentType,
    cacheControl: "0",
    upsert: false,
  });
  if (uploadError && !String(uploadError.message || "").toLowerCase().includes("already exists")) throw uploadError;
  const { data: document, error } = await service.from("portal_brand_supply_document").insert({
    organization_id: actor.organization.id,
    entity_type: entityType,
    entity_id: entityType === "marketplace_product" ? null : entityId,
    source_product_id: entityType === "marketplace_product" ? entityId : null,
    source_product_name: entityType === "marketplace_product" ? entity.productName : null,
    document_state: entityType === "marketplace_product" ? "pending_sku_link" : "record_document",
    document_type: documentType,
    title,
    visibility,
    notes: nullable(body.notes, 4000),
    object_path: objectPath,
    original_name: name,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256: digest,
    scan_state: "clean",
    scan_provider: clean(scan.engine, 120) || "configured-scanner",
    uploaded_by: actor.user.id,
    uploaded_by_email: actorEmail(actor),
  }).select("id").single();
  if (error) {
    await service.storage.from(BUCKET).remove([objectPath]);
    throw error;
  }
  await logEvent(actor, "brand-supply-document-uploaded", `${entityType}_document`, String(document.id), {
    entityId,
    documentType,
    visibility,
  });
}

async function linkCatalogDocument(actor: Actor, body: Row): Promise<void> {
  if (!actor.internal) throw new SupplyError(403, "Only an Internal administrator can approve a catalog document.");
  const documentId = uuidValue(body.documentId, "document");
  const skuId = uuidValue(body.skuId, "SKU packet");
  const document = await documentFor(actor, documentId);
  if (document.entity_type !== "marketplace_product" || document.status !== "current") {
    throw new SupplyError(409, "Choose a current Canix catalog attachment.");
  }
  const { data: sku, error } = await service.from("portal_sku_intake").select("id,reference,product_name")
    .eq("id", skuId).eq("organization_id", actor.organization.id).neq("status", "archived").maybeSingle();
  if (error) throw error;
  if (!sku) throw new SupplyError(404, "SKU packet not found in this Brand.");
  const now = new Date().toISOString();
  const { error: updateError } = await service.from("portal_brand_supply_document").update({
    linked_sku_intake_id: skuId,
    document_state: "approved_sku_document",
    approved_by: actor.user.id,
    approved_by_email: actorEmail(actor),
    approved_at: now,
    updated_at: now,
  }).eq("id", documentId).eq("organization_id", actor.organization.id)
    .eq("entity_type", "marketplace_product").eq("status", "current");
  if (updateError) throw updateError;
  await logEvent(actor, "brand-catalog-document-linked", "marketplace_product_document", documentId, {
    sourceProductId: document.source_product_id,
    skuId,
    skuReference: sku.reference,
  });
}

async function documentFor(actor: Actor, documentId: string): Promise<Row> {
  let query = service.from("portal_brand_supply_document").select("*")
    .eq("id", documentId).eq("organization_id", actor.organization.id);
  if (!actor.internal) query = query.eq("visibility", "brand_and_internal");
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new SupplyError(404, "Document not found.");
  return data as Row;
}

async function downloadDocument(actor: Actor, documentId: string): Promise<Row> {
  const document = await documentFor(actor, documentId);
  const { data, error } = await service.storage.from(BUCKET).createSignedUrl(String(document.object_path), 300, {
    download: safeName(document.original_name, "document"),
  });
  if (error || !data?.signedUrl) throw error ?? new Error("Document download could not be signed.");
  await logEvent(actor, "brand-supply-document-downloaded", `${document.entity_type}_document`, documentId, {});
  return { signedUrl: data.signedUrl, fileName: document.original_name };
}

async function archiveDocument(actor: Actor, documentId: string): Promise<void> {
  if (!actor.canArchive) throw new SupplyError(403, "Only Brand managers or Internal administrators can archive documents.");
  const document = await documentFor(actor, documentId);
  if (document.status === "archived") return;
  const now = new Date().toISOString();
  const { error } = await service.from("portal_brand_supply_document").update({
    status: "archived",
    archived_by: actor.user.id,
    archived_by_email: actorEmail(actor),
    archived_at: now,
    updated_at: now,
  }).eq("id", documentId).eq("organization_id", actor.organization.id).eq("status", "current");
  if (error) throw error;
  await logEvent(actor, "brand-supply-document-archived", `${document.entity_type}_document`, documentId, {});
}

function littleEndian(value: number, bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) output[index] = (value >>> (index * 8)) & 0xff;
  return output;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = crc32(file.bytes);
    const local = concatBytes([
      littleEndian(0x04034b50, 4), littleEndian(20, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(checksum, 4),
      littleEndian(file.bytes.byteLength, 4), littleEndian(file.bytes.byteLength, 4),
      littleEndian(name.byteLength, 2), littleEndian(0, 2), name, file.bytes,
    ]);
    localParts.push(local);
    centralParts.push(concatBytes([
      littleEndian(0x02014b50, 4), littleEndian(20, 2), littleEndian(20, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2), littleEndian(checksum, 4),
      littleEndian(file.bytes.byteLength, 4), littleEndian(file.bytes.byteLength, 4),
      littleEndian(name.byteLength, 2), littleEndian(0, 2), littleEndian(0, 2), littleEndian(0, 2),
      littleEndian(0, 2), littleEndian(0, 4), littleEndian(offset, 4), name,
    ]));
    offset += local.byteLength;
  }
  const central = concatBytes(centralParts);
  return concatBytes([
    ...localParts,
    central,
    littleEndian(0x06054b50, 4), littleEndian(0, 2), littleEndian(0, 2),
    littleEndian(files.length, 2), littleEndian(files.length, 2),
    littleEndian(central.byteLength, 4), littleEndian(offset, 4), littleEndian(0, 2),
  ]);
}

async function downloadEntity(actor: Actor, entityType: string, entityId: string): Promise<Row> {
  const entity = await entityFor(actor, entityType, entityId);
  let query = service.from("portal_brand_supply_document").select("*")
    .eq("organization_id", actor.organization.id).eq("entity_type", entityType)
    .eq("status", "current").order("document_type").order("created_at");
  query = entityType === "marketplace_product"
    ? query.eq("source_product_id", entityId)
    : query.eq("entity_id", entityId);
  if (!actor.internal) query = query.eq("visibility", "brand_and_internal");
  const { data: documents, error } = await query;
  if (error) throw error;
  if (!documents?.length) throw new SupplyError(409, "There are no current documents to download.");
  const totalBytes = documents.reduce((total, document) => total + Number(document.size_bytes || 0), 0);
  if (totalBytes > 55 * 1024 * 1024) throw new SupplyError(413, "The document set is larger than 55 MB. Download files individually.");
  const files: { name: string; bytes: Uint8Array }[] = [];
  const used = new Map<string, number>();
  for (const document of documents as Row[]) {
    const { data: blob, error: downloadError } = await service.storage.from(BUCKET).download(String(document.object_path));
    if (downloadError || !blob) throw downloadError ?? new Error("Document unavailable.");
    const folder = safeName(document.document_type, "other");
    const base = safeName(document.original_name, "document");
    const key = `${folder}/${base}`.toLowerCase();
    const count = used.get(key) ?? 0;
    used.set(key, count + 1);
    files.push({
      name: count ? `${folder}/${count + 1}-${base}` : `${folder}/${base}`,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  }
  const archive = storedZip(files);
  const objectPath = `${actor.organization.id}/exports/${entityType}-${entityId}-${Date.now()}.zip`;
  const { error: uploadError } = await service.storage.from(BUCKET).upload(objectPath, archive, {
    contentType: "application/zip",
    cacheControl: "0",
    upsert: false,
  });
  if (uploadError) throw uploadError;
  const entityName = entityType === "sku" ? entity.product_name
    : entityType === "marketplace_product" ? entity.productName
    : entityType === "vendor" ? entity.legal_business_name : entity.name;
  const fileName = `${safeName(entityName, entityType)}-documents.zip`;
  const { data: signed, error: signedError } = await service.storage.from(BUCKET).createSignedUrl(objectPath, 300, { download: fileName });
  if (signedError || !signed?.signedUrl) throw signedError ?? new Error("Document archive could not be signed.");
  await logEvent(actor, "brand-supply-documents-zip-created", `brand_${entityType}`, entityId, { documentCount: files.length });
  return { signedUrl: signed.signedUrl, fileName, documentCount: files.length };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !verifiedTokenIsAuthenticated(authorization)) {
      throw new SupplyError(403, "Forbidden");
    }
    const body = await request.json().catch(() => ({})) as Row;
    const organizationId = uuidValue(body.organizationId, "Brand organization");
    const actor = await actorFor(request, organizationId);
    const action = clean(body.action, 60).toLowerCase();
    if (action === "get") return json(request, { ok: true, ...(await snapshotFor(actor)) });
    if (action === "save-vendor") await saveVendor(actor, body);
    else if (action === "save-component") await saveComponent(actor, body);
    else if (action === "submit") await submitRecord(actor, clean(body.entityType, 40), uuidValue(body.entityId, "record"));
    else if (action === "review") await reviewRecord(actor, body);
    else if (action === "upload-document") await uploadDocument(actor, body);
    else if (action === "link-catalog-document") await linkCatalogDocument(actor, body);
    else if (action === "archive-document") await archiveDocument(actor, uuidValue(body.documentId, "document"));
    else if (action === "download-document") {
      return json(request, { ok: true, ...(await downloadDocument(actor, uuidValue(body.documentId, "document"))) });
    } else if (action === "download-entity") {
      return json(request, { ok: true, ...(await downloadEntity(
        actor,
        clean(body.entityType, 40),
        clean(body.entityType, 40) === "marketplace_product"
          ? clean(body.entityId, 100)
          : uuidValue(body.entityId, "record"),
      )) });
    } else throw new SupplyError(400, "Unknown Brand supply-chain action.");
    return json(request, { ok: true, ...(await snapshotFor(actor)) });
  } catch (error) {
    const status = error instanceof SupplyError ? error.status : 500;
    if (status === 500) console.error("portal-brand-supply-chain", error);
    return json(request, {
      error: status === 500
        ? "The Brand product workspace could not complete the request."
        : error instanceof Error ? error.message : "Request failed.",
    }, status);
  }
});
