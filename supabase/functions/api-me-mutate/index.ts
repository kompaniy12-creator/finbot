// PATCH /api-me-mutate { name?: string, locale?: "uk"|"ru"|"pl"|"en" }
//
// Lets the authenticated user update their own display name and/or interface
// language. No special role required - it only edits the caller's own
// family_members row (locale is also mirrored onto the tenant so cron summaries
// and AI replies use it). Admin name changes for other members go through
// api-family-mutate.
import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

const BodySchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  locale: z.enum(["uk", "ru", "pl", "en"]).optional(),
}).refine((b) => b.name !== undefined || b.locale !== undefined, {
  message: "nothing to update",
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

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.locale !== undefined) patch.locale = body.locale;

  const upd = await db.from("family_members")
    .update(patch)
    .eq("id", me.id)
    .select("id, name, role, locale")
    .maybeSingle();
  if (upd.error) return json(req, { error: upd.error.message }, 500);

  // Mirror locale onto the tenant so cron + AI replies follow the same language.
  if (body.locale !== undefined) {
    await sb.from("tenants").update({ locale: body.locale }).eq("id", me.tenant_id);
  }

  return json(req, { ok: true, member: upd.data });
});
