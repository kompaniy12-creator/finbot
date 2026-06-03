// GET /api-family             - active family members (default)
// GET /api-family?all=1       - all members including inactive (admin only;
//                                used by the Settings → Пользователи panel)
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("all") === "1";
  // Listing inactive members exposes who was kicked / had access revoked;
  // gate behind admin role to be conservative.
  if (includeInactive && me.role !== "admin") return forbidden(req);

  let q = sb.from("family_members")
    .select("id, name, role, telegram_id, active")
    .order("active", { ascending: false })
    .order("role", { ascending: true });
  if (!includeInactive) q = q.eq("active", true);
  const res = await q;
  if (res.error) return json(req, { error: res.error.message }, 500);
  return json(req, { items: res.data ?? [] });
});
