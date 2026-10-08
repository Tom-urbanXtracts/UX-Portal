import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";
import { ContentScanError, scanContent, sha256Hex } from "../_shared/content-scanner.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "portal-work-evidence";
const ALLOWED_ORIGINS = new Set([
  "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
  "https://portal.urbanxtracts.com",
  "https://tom-urbanxtracts.github.io",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Actor = { user: Row; profile: Row; organization: Row; internal: boolean };

class SupportError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

function requestOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return ALLOWED_ORIGINS.has(candidate) ? candidate : "https://portal.urbanxtracts.com";
}

function cors(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": requestOrigin(request),
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

function uuid(value: unknown, label: string): string {
  const candidate = clean(value, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    throw new SupportError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

function actorEmail(actor: Actor): string {
  return clean(actor.user.email || actor.profile.full_name, 320).toLowerCase();
}

async function actorFor(request: Request, organizationId: string): Promise<Actor> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !verifiedTokenIsAuthenticated(authorization)) {
    throw new SupportError(403, "Forbidden");
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) throw new SupportError(403, "Forbidden");
  const user = await response.json() as Row;
  const { data: profile, error: profileError } = await service.from("portal_profile")
    .select("id,full_name,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.active === false) throw new SupportError(403, "Forbidden");
  const { data: organization, error: organizationError } = await service.from("portal_organization")
    .select("id,kind,legal_name,display_name,status").eq("id", organizationId).eq("kind", "brand").maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new SupportError(404, "Brand organization not found.");
  const internal = profile.role === "internal" && profile.staff_role === "administrator";
  if (!internal) {
    if (profile.role !== "brand") throw new SupportError(403, "Forbidden");
    const { data: membership, error } = await service.from("portal_organization_membership").select("id")
      .eq("profile_id", profile.id).eq("organization_id", organizationId)
      .eq("workspace", "brand").eq("status", "active").maybeSingle();
    if (error) throw error;
    if (!membership) throw new SupportError(403, "This Brand is outside your access scope.");
  }
  return { user, profile: profile as Row, organization: organization as Row, internal };
}

async function snapshot(actor: Actor): Promise<Row> {
  const { data: items, error } = await service.from("portal_work_item")
    .select("id,reference,workflow_key,target_type,target_id,title,summary,status,priority,assigned_department,due_at,metadata,created_at,updated_at,completed_at")
    .eq("organization_id", actor.organization.id)
    .in("workflow_key", ["brand_tasks", "brand_support", "brand_order_issues"])
    .order("updated_at", { ascending: false }).limit(200);
  if (error) throw error;
  const ids = (items ?? []).map((item) => item.id);
  let comments: Row[] = [];
  let evidence: Row[] = [];
  if (ids.length) {
    let commentsQuery = service.from("portal_work_item_comment")
      .select("id,work_item_id,body,visibility,created_by_email,created_at").in("work_item_id", ids)
      .order("created_at", { ascending: true });
    if (!actor.internal) commentsQuery = commentsQuery.eq("visibility", "brand");
    const commentsResult = await commentsQuery;
    if (commentsResult.error) throw commentsResult.error;
    comments = (commentsResult.data ?? []) as Row[];
    const evidenceResult = await service.from("portal_work_item_evidence")
      .select("id,work_item_id,evidence_type,original_name,content_type,size_bytes,scan_state,created_by_email,created_at")
      .in("work_item_id", ids).eq("scan_state", "clean").order("created_at", { ascending: true });
    if (evidenceResult.error) throw evidenceResult.error;
    evidence = (evidenceResult.data ?? []) as Row[];
  }
  return {
    organization: actor.organization,
    items: (items ?? []).map((item) => ({
      ...item,
      comments: comments.filter((comment) => comment.work_item_id === item.id),
      evidence: evidence.filter((entry) => entry.work_item_id === item.id),
    })),
    capabilities: { canCreate: true, canComment: true, canManage: actor.internal },
  };
}

function decodeAttachment(value: unknown): { bytes: Uint8Array; name: string; contentType: string } | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Row;
  const encoded = clean(file.base64, 15_000_000);
  if (!encoded) return null;
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new SupportError(400, "The attachment could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!bytes.byteLength || bytes.byteLength !== Number(file.sizeBytes || 0) || bytes.byteLength > 10 * 1024 * 1024) {
    throw new SupportError(400, "Attachments must be 10 MB or smaller.");
  }
  const contentType = clean(file.contentType, 120).toLowerCase();
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!((contentType === "application/pdf" && pdf) || (contentType === "image/png" && png) || (contentType === "image/jpeg" && jpeg))) {
    throw new SupportError(400, "Use a PDF, PNG, or JPEG whose contents match its file type.");
  }
  return { bytes, contentType, name: clean(file.name, 240) || "issue-attachment" };
}

async function storeAttachment(actor: Actor, workItemId: string, value: unknown): Promise<void> {
  const file = decodeAttachment(value);
  if (!file) return;
  const digest = await sha256Hex(file.bytes);
  let scan;
  try {
    scan = await scanContent(file.bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError && error.verdict === "infected") {
      throw new SupportError(422, "The attachment was blocked by malware scanning.");
    }
    throw new SupportError(503, "The attachment scanner is unavailable. The issue was not submitted.");
  }
  const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/png" ? "png" : "jpg";
  const objectPath = `${actor.organization.id}/issues/${workItemId}/${digest}.${extension}`;
  const { error: uploadError } = await service.storage.from(BUCKET).upload(objectPath, file.bytes, {
    contentType: file.contentType, cacheControl: "0", upsert: false,
  });
  if (uploadError) throw uploadError;
  const { error } = await service.from("portal_work_item_evidence").insert({
    work_item_id: workItemId,
    evidence_type: "brand_issue_attachment",
    object_path: objectPath,
    original_name: file.name,
    content_type: file.contentType,
    size_bytes: file.bytes.byteLength,
    scan_state: "clean",
    created_by: actor.user.id,
    created_by_email: actorEmail(actor),
  });
  if (error) throw error;
  void scan;
}

async function createIssue(actor: Actor, body: Row): Promise<void> {
  const issueType = clean(body.issueType, 30).toLowerCase();
  if (!["order", "portal"].includes(issueType)) throw new SupportError(400, "Choose an order or portal issue.");
  const category = clean(body.category, 80) || "other";
  const subject = clean(body.subject, 180);
  const description = clean(body.description, 4000);
  if (!subject || !description) throw new SupportError(400, "Enter an issue subject and description.");
  let orderId: string | null = null;
  let orderReference: string | null = null;
  if (issueType === "order") {
    orderId = uuid(body.orderId, "purchase order");
    const { data: order, error } = await service.from("portal_brand_purchase_order")
      .select("id,reference").eq("id", orderId).eq("organization_id", actor.organization.id).maybeSingle();
    if (error) throw error;
    if (!order) throw new SupportError(404, "Purchase order not found for this Brand.");
    orderReference = clean(order.reference, 120);
  }
  const targetId = crypto.randomUUID();
  const workflowKey = issueType === "order" ? "brand_order_issues" : "brand_support";
  const title = issueType === "order" ? `${orderReference}: ${subject}` : subject;
  const metadata = {
    category,
    orderId,
    orderReference,
    page: clean(body.page, 240) || null,
    browser: clean(body.browser, 500) || null,
    appVersion: clean(body.appVersion, 80) || null,
    preferredContact: clean(body.preferredContact, 320) || actorEmail(actor),
    affectedItems: clean(body.affectedItems, 1000) || null,
  };
  const { data: item, error } = await service.from("portal_work_item").insert({
    workflow_key: workflowKey,
    target_type: issueType === "order" ? "brand_purchase_order_issue" : "portal_issue",
    target_id: targetId,
    organization_id: actor.organization.id,
    title,
    summary: description,
    status: "not_started",
    priority: issueType === "order" ? "P1" : "P2",
    assigned_department: "Administrator",
    source_mode: "portal",
    metadata,
    created_by: actor.user.id,
    updated_by: actor.user.id,
  }).select("id").single();
  if (error) throw error;
  try {
    await storeAttachment(actor, String(item.id), body.attachment);
    const { error: commentError } = await service.from("portal_work_item_comment").insert({
      work_item_id: item.id,
      body: description,
      visibility: "brand",
      created_by: actor.user.id,
      created_by_email: actorEmail(actor),
    });
    if (commentError) throw commentError;
  } catch (error) {
    await service.from("portal_work_item").delete().eq("id", item.id);
    throw error;
  }
}

async function addComment(actor: Actor, body: Row): Promise<void> {
  const workItemId = uuid(body.workItemId, "work item");
  const message = clean(body.message, 4000);
  if (!message) throw new SupportError(400, "Enter a comment.");
  const { data: item, error: itemError } = await service.from("portal_work_item").select("id")
    .eq("id", workItemId).eq("organization_id", actor.organization.id)
    .in("workflow_key", ["brand_tasks", "brand_support", "brand_order_issues"]).maybeSingle();
  if (itemError) throw itemError;
  if (!item) throw new SupportError(404, "Work item not found.");
  const { error } = await service.from("portal_work_item_comment").insert({
    work_item_id: workItemId,
    body: message,
    visibility: "brand",
    created_by: actor.user.id,
    created_by_email: actorEmail(actor),
  });
  if (error) throw error;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
  try {
    const body = await request.json().catch(() => ({})) as Row;
    const organizationId = uuid(body.organizationId, "Brand organization");
    const actor = await actorFor(request, organizationId);
    const action = clean(body.action, 60).toLowerCase();
    if (action === "get") return json(request, { ok: true, ...(await snapshot(actor)) });
    if (action === "create-issue") {
      await createIssue(actor, body);
      return json(request, { ok: true, ...(await snapshot(actor)) }, 201);
    }
    if (action === "add-comment") {
      await addComment(actor, body);
      return json(request, { ok: true, ...(await snapshot(actor)) });
    }
    throw new SupportError(400, "Unknown Brand support action.");
  } catch (error) {
    const status = error instanceof SupportError ? error.status : 500;
    if (status === 500) console.error("portal-brand-support", error);
    return json(request, {
      error: status === 500
        ? "The Brand support workspace could not complete the request."
        : error instanceof Error ? error.message : "Request failed.",
    }, status);
  }
});
