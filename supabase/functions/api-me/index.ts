// GET /api-me: returns the authenticated FamilyMember plus other family members' names.
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  const others = await sb.from("family_members").select("id, name, role").eq("active", true);
  return json(req, {
    me,
    family: (others.data ?? []) as Array<{ id: string; name: string; role: string }>,
  });
});
