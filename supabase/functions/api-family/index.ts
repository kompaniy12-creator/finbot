// GET /api-family: active family members (id, name, role).
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  const res = await sb.from("family_members")
    .select("id, name, role, telegram_id")
    .eq("active", true)
    .order("role", { ascending: true });
  if (res.error) return json(req, { error: res.error.message }, 500);
  return json(req, { items: res.data ?? [] });
});
