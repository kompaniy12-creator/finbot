// POST /api-recategorize
// Body: { expense_id: <uuid>, category_id: <uuid> }
// User-triggered correction of an auto-assigned category. Owner-or-admin gate.
// Sets corrected_by_user=true so the retraining job weights this row higher.
// Audit trigger logs the change as 'recategorize'.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { log } from "../_shared/log.ts";

const BodySchema = z.object({
  expense_id: z.string().regex(/^[0-9a-f-]{36}$/i),
  category_id: z.string().regex(/^[0-9a-f-]{36}$/i),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  const initData = extractInitData(req);
  if (!initData) return unauthorized(req);
  const sb = adminClient();
  const me = await authenticateInitData(initData, sb);
  if (!me) return unauthorized(req);

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (_e) {
    return json(req, { error: "bad_request" }, 400);
  }

  const expRes = await sb.from("expenses")
    .select("id, family_member_id, category_id, archived")
    .eq("id", body.expense_id)
    .maybeSingle();
  if (expRes.error) return json(req, { error: expRes.error.message }, 500);
  const exp = expRes.data as {
    id: string;
    family_member_id: string;
    category_id: string;
    archived: boolean;
  } | null;
  if (!exp) return json(req, { error: "not_found" }, 404);
  if (me.role !== "admin" && exp.family_member_id !== me.id) return forbidden(req);
  if (exp.archived) return json(req, { error: "archived" }, 409);

  const catRes = await sb.from("categories")
    .select("id, name")
    .eq("id", body.category_id)
    .maybeSingle();
  if (catRes.error) return json(req, { error: catRes.error.message }, 500);
  const cat = catRes.data as { id: string; name: string } | null;
  if (!cat) return json(req, { error: "category_not_found" }, 404);

  if (exp.category_id === cat.id) {
    return json(req, { ok: true, category_id: cat.id, category_name: cat.name, unchanged: true });
  }

  const upd = await sb.from("expenses")
    .update({ category_id: cat.id, corrected_by_user: true })
    .eq("id", exp.id);
  if (upd.error) return json(req, { error: upd.error.message }, 500);

  log("info", "recategorize", {
    expense_id: exp.id,
    from: exp.category_id,
    to: cat.id,
    actor: me.telegram_id,
  });
  return json(req, { ok: true, category_id: cat.id, category_name: cat.name });
});
