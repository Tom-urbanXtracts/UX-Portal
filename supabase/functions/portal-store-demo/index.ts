import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifiedTokenIsAuthenticated } from "../_shared/auth.ts";
import { DemoError, demoRole, initialDemoState, mutateDemo, projectDemo, type DemoState } from "../_shared/store-demo.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
const origins = new Set(["https://portal.urbanxtracts.com", "https://urbanxtracts-ux-os-inventory.tamem.chatgpt.site", "http://127.0.0.1:4173", "http://localhost:4173"]);
Deno.serve(async request => {
  const origin = request.headers.get("origin") || "";
  const headers = { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "vary": "Origin",
    "access-control-allow-origin": origins.has(origin) ? origin : "https://portal.urbanxtracts.com",
    "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    if (origin && !origins.has(origin)) throw new DemoError(403, "Origin not allowed.");
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) throw new DemoError(401, "Sign in is required.");
    const auth = await fetch(url + "/auth/v1/user", { headers: { authorization, apikey: anonKey } });
    if (!auth.ok || !verifiedTokenIsAuthenticated(authorization)) throw new DemoError(401, "Sign in is required.");
    const user = await auth.json();
    const { data: profile, error: pe } = await service.from("portal_profile").select("id,active,role,staff_role,full_name").eq("id", user.id).maybeSingle();
    if (pe || !profile?.active || profile.role !== "internal" || profile.staff_role !== "administrator") throw new DemoError(403, "This demonstration is limited to Internal Administrators.");
    const [{ data: membership, error: me }, { data: grant, error: ge }, { data: control, error: ce }] = await Promise.all([
      service.from("portal_organization_membership").select("id,portal_organization!inner(status)").eq("profile_id", user.id).eq("workspace", "internal").eq("member_role", "administrator").eq("status", "active").eq("portal_organization.status", "active").limit(1),
      service.from("portal_role_permission").select("permission").eq("staff_role", "administrator").eq("permission", "store.demo").maybeSingle(),
      service.from("portal_store_demo_control").select("enabled").eq("id", true).maybeSingle(),
    ]);
    if (me || ge || ce) throw new DemoError(503, "Store demonstration access could not be verified.");
    if (!membership?.length || !grant) throw new DemoError(403, "Internal Administrator membership and demo authority are required.");
    if (!control?.enabled) throw new DemoError(503, "Store demonstration is paused.");
    const raw = await request.text();
    if (raw.length > 50000) throw new DemoError(413, "Request is too large.");
    let body;
    try { body = JSON.parse(raw); } catch { throw new DemoError(400, "Invalid request."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DemoError(400, "Invalid request.");
    const role = demoRole(body.role);
    const { data: session, error } = await service.from("portal_store_demo_session").select("revision,state").eq("actor_id", user.id).maybeSingle();
    if (error) throw error;
    let state = (session?.state || initialDemoState()) as DemoState;
    let revision = Number(session?.revision || 0);
    if (body.action !== "read") {
      if (!Number.isInteger(body.revision) || body.revision !== revision) throw new DemoError(409, "Demonstration changed; refresh before saving. Your unsaved fields are retained.");
      state = mutateDemo(state, role, body, String(profile.full_name || user.email), new Date().toISOString());
      const result = await service.rpc("portal_commit_store_demo", { p_actor_id: user.id, p_revision: revision, p_state: state, p_action: body.action });
      if (result.error) throw new DemoError(result.error.code === "40001" ? 409 : result.error.code === "42501" ? 403 : 500,
        result.error.code === "40001" ? "Demonstration changed; refresh before saving." : "The demonstration could not save that change.");
      revision = Number(result.data.revision);
    }
    return reply(projectDemo(state, role, revision));
  } catch (error) {
    if (error instanceof DemoError) return reply({ error: error.message }, error.status);
    console.error("portal-store-demo request failed");
    return reply({ error: "The Store demonstration is temporarily unavailable." }, 503);
  }
});
