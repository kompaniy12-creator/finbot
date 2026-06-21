// Owner-only admin dashboard backend.
//
//   GET  /api-admin-overview
//        -> cross-tenant stats (tenants, activity, AI cost) via admin_overview().
//   POST /api-admin-overview { tenant_id: uuid, action: "suspend" | "activate" }
//        -> suspend/activate a SaaS tenant via admin_set_tenant_access().
//
// Only the bot owner (admin of the family sentinel tenant) may use this. Any
// other authenticated user gets a 404 so the endpoint's existence isn't leaked.
// The handler talks to the DB exclusively through SECURITY-checked RPCs
// (admin_overview / admin_set_tenant_access), so there is no raw cross-tenant
// table read here and the tenant-scoping guard has nothing to flag.
import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { FAMILY_TENANT } from "../_shared/claude.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

const ActionSchema = z.object({
  tenant_id: z.string().uuid(),
  action: z.enum(["suspend", "activate"]),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);

  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  // Owner gate: family-tenant admin only. Others get a generic not_found.
  const isOwner = me.tenant_id === FAMILY_TENANT && me.role === "admin";
  if (!isOwner) return json(req, { error: "not_found" }, 404);

  if (req.method === "GET") {
    const r = await sb.rpc("admin_overview");
    if (r.error) return json(req, { error: r.error.message }, 500);
    return json(req, r.data ?? { tenants: [] });
  }

  if (req.method === "POST") {
    let body: z.infer<typeof ActionSchema>;
    try {
      body = ActionSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const r = await sb.rpc("admin_set_tenant_access", {
      p_tenant_id: body.tenant_id,
      p_active: body.action === "activate",
    });
    if (r.error) return json(req, { error: r.error.message }, 500);
    return json(req, { ok: true, result: r.data });
  }

  return json(req, { error: "method_not_allowed" }, 405);
});
