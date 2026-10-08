import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";
import {
  ContentScanError,
  scanContent,
  sha256Hex,
} from "../_shared/content-scanner.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type Administrator = { id: string; email: string };

class QueueError extends Error {
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
    },
  });
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function uuid(value: unknown, label: string): string {
  const candidate = clean(value, 80);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(candidate)
  ) throw new QueueError(400, `Choose a valid ${label}.`);
  return candidate;
}

function choice(
  value: unknown,
  allowed: string[],
  label: string,
): string {
  const candidate = clean(value, 80);
  if (!allowed.includes(candidate)) {
    throw new QueueError(400, `Choose a valid ${label}.`);
  }
  return candidate;
}

async function administratorFor(request: Request): Promise<Administrator> {
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    !verifiedTokenIsAuthenticated(authorization)
  ) throw new QueueError(403, "Forbidden");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization },
  });
  if (!response.ok) throw new QueueError(403, "Forbidden");
  const user = await response.json() as Row;
  const { data, error } = await service.from("portal_profile")
    .select("id,role,staff_role,active").eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (
    !data || data.active === false || data.role !== "internal" ||
    data.staff_role !== "administrator"
  ) throw new QueueError(403, "Administrator access is required.");
  return { id: String(data.id), email: clean(user.email, 254) };
}

async function queueOverview(): Promise<Row> {
  const [controlResult, itemResult, claimPolicyResult, retentionResult] =
    await Promise.all([
      service.from("portal_workflow_control").select("*").order("display_name"),
      service.from("portal_work_item").select(
        "*,portal_work_item_comment(id,body,visibility,created_by_email,created_at),portal_work_item_evidence(id,evidence_type,original_name,content_type,size_bytes,scan_state,external_reference,created_by_email,created_at),portal_work_item_event(id,action,from_status,to_status,actor_email,detail,created_at)",
      ).order("priority").order("created_at"),
      service.from("portal_receiving_claim_policy").select("*").eq("id", 1)
        .maybeSingle(),
      service.from("portal_document_retention_rule").select(
        "record_class,display_name,policy_state,automatic_deletion_enabled,notes",
      ).order("display_name"),
    ]);
  for (
    const result of [
      controlResult,
      itemResult,
      claimPolicyResult,
      retentionResult,
    ]
  ) if (result.error) throw result.error;
  const items = (itemResult.data ?? []) as Row[];
  const counts = items.reduce((summary: Record<string, number>, item) => {
    const state = String(item.status);
    summary[state] = (summary[state] ?? 0) + 1;
    return summary;
  }, {});
  return {
    controls: controlResult.data ?? [],
    items,
    summary: {
      total: items.length,
      notStarted: counts.not_started ?? 0,
      inProgress: counts.in_progress ?? 0,
      waiting: counts.waiting ?? 0,
      completed: counts.completed ?? 0,
      cancelled: counts.cancelled ?? 0,
      overdue: items.filter((item) =>
        item.due_at && !["completed", "cancelled"].includes(String(item.status)) &&
        new Date(String(item.due_at)).getTime() < Date.now()
      ).length,
    },
    claimPolicy: claimPolicyResult.data ?? null,
    retention: {
      rules: retentionResult.data ?? [],
      automaticDeletionEnabled: (retentionResult.data ?? []).some((row) =>
        row.automatic_deletion_enabled === true
      ),
    },
  };
}

async function updateItem(actor: Administrator, body: Row): Promise<Row> {
  const id = uuid(body.workItemId, "work item");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new QueueError(400, "Refresh the work item before saving it.");
  }
  const changes: Row = {
    status: choice(
      body.status,
      ["not_started", "in_progress", "waiting", "completed", "cancelled"],
      "status",
    ),
    priority: choice(body.priority, ["P0", "P1", "P2", "P3"], "priority"),
    assigned_department: "Administrator",
    assigned_user: body.assignedUserId
      ? uuid(body.assignedUserId, "assignee")
      : null,
    due_at: clean(body.dueAt, 40) || null,
    updated_by: actor.id,
  };
  const { data, error } = await service.from("portal_work_item").update(changes)
    .eq("id", id).eq("version", expectedVersion).select().maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new QueueError(
      409,
      "This work item changed since it was opened. Refresh before saving.",
    );
  }
  await service.from("portal_work_item_event").insert({
    work_item_id: id,
    action: "administrator_decision",
    from_status: null,
    to_status: changes.status,
    actor_id: actor.id,
    actor_email: actor.email,
    detail: {
      priority: changes.priority,
      assignedDepartment: "Administrator",
      dueAt: changes.due_at,
    },
  });
  return { workItem: data };
}

async function addComment(actor: Administrator, body: Row): Promise<Row> {
  const id = uuid(body.workItemId, "work item");
  const comment = clean(body.comment, 4000);
  if (!comment) throw new QueueError(400, "Enter a comment before saving.");
  const { data: item, error: itemError } = await service.from(
    "portal_work_item",
  ).select("id").eq("id", id).maybeSingle();
  if (itemError) throw itemError;
  if (!item) throw new QueueError(404, "Work item not found.");
  const { data, error } = await service.from("portal_work_item_comment").insert({
    work_item_id: id,
    body: comment,
    visibility: choice(body.visibility || "internal", ["internal", "brand", "store"], "visibility"),
    created_by: actor.id,
    created_by_email: actor.email,
  }).select().single();
  if (error) throw error;
  await service.from("portal_work_item_event").insert({
    work_item_id: id,
    action: "comment_added",
    actor_id: actor.id,
    actor_email: actor.email,
    detail: { visibility: data.visibility },
  });
  return { comment: data };
}

function decodeEvidence(file: Row): {
  bytes: Uint8Array;
  name: string;
  contentType: string;
} {
  const contentType = clean(file.contentType, 120).toLowerCase();
  const allowed = ["application/pdf", "image/png", "image/jpeg"];
  const encoded = clean(file.base64, 15_000_000).replace(/\s/g, "");
  if (!allowed.includes(contentType) || !encoded) {
    throw new QueueError(400, "Use a PDF, PNG, or JPEG that is 10 MB or smaller.");
  }
  let binary = "";
  try {
    binary = atob(encoded);
  } catch {
    throw new QueueError(400, "The evidence file could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    !Number(file.sizeBytes) || bytes.byteLength !== Number(file.sizeBytes) ||
    bytes.byteLength > 10 * 1024 * 1024
  ) throw new QueueError(400, "Evidence files must be 10 MB or smaller.");
  const signatureMatches = contentType === "application/pdf"
    ? bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
    : contentType === "image/png"
    ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!signatureMatches) {
    throw new QueueError(400, "The uploaded contents do not match the declared file type.");
  }
  return {
    bytes,
    name: clean(file.name, 240) || "evidence",
    contentType,
  };
}

async function uploadEvidence(
  actor: Administrator,
  body: Row,
): Promise<Row> {
  const workItemId = uuid(body.workItemId, "work item");
  const file = body.file && typeof body.file === "object" &&
      !Array.isArray(body.file)
    ? body.file as Row
    : {};
  const decoded = decodeEvidence(file);
  const digest = await sha256Hex(decoded.bytes);
  try {
    await scanContent(decoded.bytes, digest);
  } catch (error) {
    if (error instanceof ContentScanError) {
      throw new QueueError(422, error.message);
    }
    throw error;
  }
  const extension = decoded.contentType === "application/pdf"
    ? "pdf"
    : decoded.contentType === "image/png"
    ? "png"
    : "jpg";
  const objectPath = `${workItemId}/${crypto.randomUUID()}-${digest.slice(0, 16)}.${extension}`;
  const { error: uploadError } = await service.storage.from(
    "portal-work-evidence",
  ).upload(objectPath, decoded.bytes, {
    contentType: decoded.contentType,
    upsert: false,
  });
  if (uploadError) throw uploadError;
  const { data, error } = await service.from("portal_work_item_evidence")
    .insert({
      work_item_id: workItemId,
      evidence_type: clean(body.evidenceType, 100) || "supporting_document",
      object_path: objectPath,
      original_name: decoded.name,
      content_type: decoded.contentType,
      size_bytes: decoded.bytes.byteLength,
      scan_state: "clean",
      created_by: actor.id,
      created_by_email: actor.email,
    }).select().single();
  if (error) {
    await service.storage.from("portal-work-evidence").remove([objectPath]);
    throw error;
  }
  await service.from("portal_work_item_event").insert({
    work_item_id: workItemId,
    action: "evidence_added",
    actor_id: actor.id,
    actor_email: actor.email,
    detail: {
      evidenceId: data.id,
      evidenceType: data.evidence_type,
      scanState: "clean",
      sha256: digest,
    },
  });
  return { evidence: data };
}

async function updateWorkflow(
  actor: Administrator,
  body: Row,
): Promise<Row> {
  const workflowKey = clean(body.workflowKey, 80);
  const mode = choice(
    body.mode,
    ["hold", "monday", "parallel", "portal"],
    "workflow mode",
  );
  const note = clean(body.note, 2000);
  if (!workflowKey || note.length < 8) {
    throw new QueueError(400, "Record the workflow and reason for this change.");
  }
  const { data, error } = await service.from("portal_workflow_control").update({
    mode,
    monday_retention: mode === "monday" || mode === "parallel"
      ? "retain_active"
      : "retain_read_only",
    change_note: note,
    changed_by: actor.id,
    changed_by_email: actor.email,
    changed_at: new Date().toISOString(),
  }).eq("workflow_key", workflowKey).select().maybeSingle();
  if (error) throw error;
  if (!data) throw new QueueError(404, "Workflow control not found.");
  return { control: data };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (!new Set(["GET", "POST"]).has(request.method)) {
    return json(request, { error: "Method not allowed" }, 405);
  }
  try {
    const actor = await administratorFor(request);
    if (request.method === "GET") {
      return json(request, await queueOverview());
    }
    const body = await request.json() as Row;
    const action = clean(body.action, 80);
    if (action === "update-item") {
      return json(request, await updateItem(actor, body));
    }
    if (action === "add-comment") {
      return json(request, await addComment(actor, body));
    }
    if (action === "upload-evidence") {
      return json(request, await uploadEvidence(actor, body));
    }
    if (action === "update-workflow") {
      return json(request, await updateWorkflow(actor, body));
    }
    throw new QueueError(400, "Unsupported work-queue action.");
  } catch (error) {
    if (!(error instanceof QueueError)) console.error("portal-work-queue", error);
    return json(request, {
      error: error instanceof QueueError
        ? error.message
        : "The work queue is temporarily unavailable.",
    }, error instanceof QueueError ? error.status : 500);
  }
});
