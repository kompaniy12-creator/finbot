// PATCH /api-me-mutate { name: string }
//
// Lets the authenticated user update their own display name (the one the bot
// uses to greet them: "Привет, Серхий"). No special role required - this
// only edits the caller's own family_members row. Admin name changes for
// other members go through api-family-mutate.
import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

const BodySchema = z.object({
  name: z.string().trim().min(1).max(60),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "PATCH") return json(req, { error: "method_not_allowed" }, 405);

  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  const db = tenantDb(sb, me.tenant_id);

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (_e) {
    return json(req, { error: "bad_request" }, 400);
  }

  const upd = await db.from("family_members")
    .update({ name: body.name })
    .eq("id", me.id)
    .select("id, name, role")
    .maybeSingle();
  if (upd.error) return json(req, { error: upd.error.message }, 500);

  return json(req, { ok: true, member: upd.data });
});
