// POST /api-delete-item
// Body: { kind: "expense" | "receipt", id: <uuid> }
// Soft-deletes (archives) one record. For kind="receipt", also archives every
// child expense line. Audit trigger on `expenses` captures the archive event.
//
// Auth: Telegram initData. Only the owner of the record (or an admin) can delete.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { log } from "../_shared/log.ts";

const BodySchema = z.object({
  kind: z.enum(["expense", "receipt"]),
  id: z.string().regex(/^[0-9a-f-]{36}$/i),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (_e) {
    return json(req, { error: "bad_request" }, 400);
  }

  if (body.kind === "expense") {
    const lookup = await sb.from("expenses")
      .select("id, family_member_id, archived, receipt_id, name")
      .eq("id", body.id)
      .maybeSingle();
    if (lookup.error) return json(req, { error: lookup.error.message }, 500);
    const row = lookup.data as {
      id: string;
      family_member_id: string;
      archived: boolean;
      receipt_id: string | null;
      name: string;
    } | null;
    if (!row) return json(req, { error: "not_found" }, 404);
    if (me.role !== "admin" && row.family_member_id !== me.id) return forbidden(req);
    if (row.archived) return json(req, { ok: true, already: true });

    const upd = await sb.from("expenses").update({ archived: true }).eq("id", row.id);
    if (upd.error) return json(req, { error: upd.error.message }, 500);
    log("info", "item_deleted", {
      kind: "expense",
      id: row.id,
      actor: me.telegram_id,
      receipt_id: row.receipt_id,
    });
    return json(req, { ok: true, kind: "expense", id: row.id });
  }

  // kind === "receipt": archive the receipt and all its expense lines.
  const recLookup = await sb.from("receipts")
    .select("id, family_member_id, archived, merchant")
    .eq("id", body.id)
    .maybeSingle();
  if (recLookup.error) return json(req, { error: recLookup.error.message }, 500);
  const rec = recLookup.data as {
    id: string;
    family_member_id: string;
    archived: boolean;
    merchant: string | null;
  } | null;
  if (!rec) return json(req, { error: "not_found" }, 404);
  if (me.role !== "admin" && rec.family_member_id !== me.id) return forbidden(req);
  if (rec.archived) return json(req, { ok: true, already: true });

  const updLines = await sb.from("expenses")
    .update({ archived: true })
    .eq("receipt_id", rec.id)
    .eq("archived", false);
  if (updLines.error) return json(req, { error: updLines.error.message }, 500);

  const updRec = await sb.from("receipts").update({ archived: true }).eq("id", rec.id);
  if (updRec.error) return json(req, { error: updRec.error.message }, 500);

  log("info", "item_deleted", {
    kind: "receipt",
    id: rec.id,
    actor: me.telegram_id,
  });
  return json(req, { ok: true, kind: "receipt", id: rec.id });
});
