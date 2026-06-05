// GET /api-categories: list with usage_count.
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  const db = tenantDb(sb, me.tenant_id);

  const res = await db.from("categories")
    .select("id, name, description, usage_count, is_fallback, kind")
    .order("usage_count", { ascending: false });
  if (res.error) return json(req, { error: res.error.message }, 500);
  return json(req, { items: res.data ?? [] });
});
