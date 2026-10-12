import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sha256Hex } from "../_shared/content-scanner.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Authorization boundary: the browser supplies a high-entropy capability token;
// only its SHA-256 digest is compared with the server-only record.
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;

function allowedOrigin(request: Request): string {
  const candidate = request.headers.get("origin") ?? "";
  return new Set([
    "https://portal.urbanxtracts.com",
    "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site",
    "https://tom-urbanxtracts.github.io",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
  ]).has(candidate) ? candidate : "https://portal.urbanxtracts.com";
}

function headers(request: Request): HeadersInit {
  return {
    "access-control-allow-origin": allowedOrigin(request),
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    "cache-control": "no-store, private",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: headers(request) });
}

function clean(value: unknown, max = 4000): string {
  return String(value ?? "").trim().slice(0, max);
}

function validToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,80}$/.test(value);
}

async function tokenDigest(token: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(token));
}

async function approvalContext(token: string): Promise<Row> {
  if (!validToken(token)) throw new Error("This approval link is invalid.");
  const hash = await tokenDigest(token);
  const { data: link, error: linkError } = await service.from(
    "portal_purchase_approval_link",
  ).select(
    "id,purchase_request_id,approver_name,approver_email,expires_at,consumed_at,revoked_at,decision,decision_note",
  ).eq("token_hash", hash).maybeSingle();
  if (linkError) throw linkError;
  if (!link) throw new Error("This approval link is invalid.");
  const { data: request, error: requestError } = await service.from(
    "portal_purchase_request",
  ).select(
    "id,reference,vendor_name,purpose,priority,needed_by,requested_for_department_key,recipient_name,delivery_location,merchandise_subtotal,estimated_shipping,estimated_tax,estimated_discount,amount,approval_authority,status,business_approval_status,business_approver_name,business_approver_email,business_decided_at,business_approval_note,brand:portal_organization!brand_organization_id(display_name),portal_purchase_request_line(line_number,item_description,sku,purchase_url,image_url,selected_options,substitution_policy,quantity,unit_cost,subtotal,expense_category,expense_subcategory,required_delivery_on)",
  ).eq("id", link.purchase_request_id).maybeSingle();
  if (requestError) throw requestError;
  if (!request) throw new Error("This Supply Order is unavailable.");
  const expired = new Date(link.expires_at).getTime() <= Date.now();
  const decided = Boolean(link.consumed_at || link.revoked_at || request.business_approval_status !== "pending");
  return {
    link: {
      approverName: link.approver_name,
      expiresAt: link.expires_at,
      expired,
      decided,
      decision: link.decision || request.business_approval_status,
    },
    request,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json(request, { error: "Approval service is unavailable." }, 503);
  try {
    const body = await request.json() as Row;
    const action = clean(body.action, 20);
    const token = clean(body.token, 160);
    if (action === "review") return json(request, await approvalContext(token));
    if (action !== "decide") return json(request, { error: "Choose a valid approval action." }, 400);
    if (!validToken(token)) return json(request, { error: "This approval link is invalid." }, 400);
    const decision = clean(body.decision, 20);
    const note = clean(body.note, 4000);
    if (!new Set(["approved", "denied"]).has(decision)) {
      return json(request, { error: "Choose approve or reject." }, 400);
    }
    if (decision === "denied" && note.length < 8) {
      return json(request, { error: "Add a rejection reason of at least 8 characters." }, 400);
    }
    const hash = await tokenDigest(token);
    const { data, error } = await service.rpc("portal_decide_purchase_by_token", {
      p_token_hash: hash,
      p_decision: decision,
      p_note: note || null,
    });
    if (error) {
      const message = String(error.message || "");
      if (/expired|already been used|no longer awaiting/i.test(message)) {
        return json(request, { error: message }, 409);
      }
      if (/invalid|rejection reason/i.test(message)) return json(request, { error: message }, 400);
      throw error;
    }
    return json(request, {
      decision,
      request: {
        reference: data.reference,
        status: data.status,
        approverName: data.business_approver_name,
        approverEmail: data.business_approver_email,
        decidedAt: data.business_decided_at,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval service failed.";
    const status = /invalid|unavailable/i.test(message) ? 400 : 500;
    return json(request, { error: status === 500 ? "Approval service failed." : message }, status);
  }
});
