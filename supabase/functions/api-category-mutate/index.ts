// POST   /api-category-mutate              { name, description, is_fallback? } -> create
// PATCH  /api-category-mutate?id=<uuid>    { name?, description?, is_fallback? } -> update
// DELETE /api-category-mutate?id=<uuid>                                           -> delete
//
// Admin-only. Embeddings are computed via Supabase.ai gte-small from the
// English description. Delete reassigns every expense + recurring_expense
// row from the deleted category to the family's fallback category before
// removing the row, so no orphan refs remain. The fallback category itself
// cannot be deleted.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { log } from "../_shared/log.ts";
import { recordAudit } from "../_shared/audit.ts";

// deno-lint-ignore no-explicit-any
declare const Supabase: any;

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  is_fallback: z.boolean().optional(),
  kind: z.enum(["expense", "income"]).default("expense"),
});
const UpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(500).optional(),
  is_fallback: z.boolean().optional(),
  // kind is intentionally not editable on update - changing kind would
  // require rewriting child expense rows too. If you need a different
  // kind, create a new category and recategorise.
});

async function embed(text: string): Promise<number[] | null> {
  try {
    const session = new Supabase.ai.Session("gte-small");
    const v = await session.run(text, { mean_pool: true, normalize: true });
    return Array.isArray(v) ? v as number[] : null;
  } catch (err) {
    log("warn", "category_mutate_embed_failed", { error: (err as Error).message });
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  const db = tenantDb(sb, me.tenant_id);
  if (me.role !== "admin") return forbidden(req);

  const url = new URL(req.url);

  if (req.method === "POST") {
    let body: z.infer<typeof CreateSchema>;
    try {
      body = CreateSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }

    // Uniqueness on name (schema enforces it but we want a friendly message).
    const exists = await db.from("categories").select("id").eq("name", body.name).maybeSingle();
    if (exists.data) return json(req, { error: "name_taken" }, 409);

    // Fallback is per-kind: one expense fallback, one income fallback. If
    // the new category claims fallback, unset only the existing fallback of
    // the SAME kind (not across kinds).
    if (body.is_fallback) {
      await db.from("categories")
        .update({ is_fallback: false })
        .eq("is_fallback", true)
        .eq("kind", body.kind);
    }

    const embedding = await embed(body.description);
    const ins = await db.from("categories").insert({
      name: body.name,
      description: body.description,
      is_fallback: body.is_fallback ?? false,
      kind: body.kind,
      embedding,
    }).select("id, name, is_fallback, kind").maybeSingle();
    if (ins.error || !ins.data) {
      return json(req, { error: ins.error?.message ?? "insert_failed" }, 500);
    }

    const newCat = ins.data as { id: string; name: string; is_fallback: boolean };
    log("info", "category_created", { id: newCat.id, name: body.name });
    await recordAudit(sb, {
      actorTelegramId: me.telegram_id,
      actorFamilyMemberId: me.id,
      action: "category_created",
      targetId: newCat.id,
      targetName: newCat.name,
      details: { is_fallback: newCat.is_fallback },
    });
    return json(req, { ok: true, category: ins.data });
  }

  if (req.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);

    let body: z.infer<typeof UpdateSchema>;
    try {
      body = UpdateSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }

    const before = await db.from("categories")
      .select("id, name, description, is_fallback, kind")
      .eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const cur = before.data as {
      id: string;
      name: string;
      description: string;
      is_fallback: boolean;
      kind: "expense" | "income";
    };

    // Name collision check.
    if (body.name && body.name !== cur.name) {
      const other = await db.from("categories")
        .select("id").eq("name", body.name).neq("id", id).maybeSingle();
      if (other.data) return json(req, { error: "name_taken" }, 409);
    }

    // is_fallback toggle: per-kind invariant - one fallback per kind.
    if (body.is_fallback === true && !cur.is_fallback) {
      await db.from("categories")
        .update({ is_fallback: false })
        .eq("is_fallback", true)
        .eq("kind", cur.kind);
    } else if (body.is_fallback === false && cur.is_fallback) {
      // Refuse to unset the last fallback for this kind: the categorizer
      // needs one to fall back to when nothing else fits.
      return json(req, { error: "need_a_fallback" }, 409);
    }

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) {
      patch.description = body.description;
      // Description drives the centroid embedding; re-embed when it changes.
      if (body.description !== cur.description) {
        patch.embedding = await embed(body.description);
        patch.centroid_updated_at = new Date().toISOString();
      }
    }
    if (body.is_fallback !== undefined) patch.is_fallback = body.is_fallback;

    if (Object.keys(patch).length === 0) {
      return json(req, { ok: true, category: cur, unchanged: true });
    }

    const upd = await db.from("categories").update(patch).eq("id", id)
      .select("id, name, description, is_fallback").maybeSingle();
    if (upd.error) return json(req, { error: upd.error.message }, 500);

    log("info", "category_updated", { id, fields: Object.keys(patch) });
    await recordAudit(sb, {
      actorTelegramId: me.telegram_id,
      actorFamilyMemberId: me.id,
      action: "category_updated",
      targetId: id,
      targetName: cur.name,
      details: { fields: Object.keys(patch), new_name: body.name ?? null },
    });
    return json(req, { ok: true, category: upd.data });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);

    const target = await db.from("categories")
      .select("id, name, is_fallback, kind").eq("id", id).maybeSingle();
    if (!target.data) return json(req, { error: "not_found" }, 404);
    const tgt = target.data as {
      id: string;
      name: string;
      is_fallback: boolean;
      kind: "expense" | "income";
    };
    if (tgt.is_fallback) return json(req, { error: "cannot_delete_fallback" }, 409);

    // Fallback receiver must be the SAME kind: income rows must land on the
    // income fallback, not the expense one (and vice versa) - otherwise we'd
    // mix kinds and break the kind-scoped categorizer downstream.
    const fb = await db.from("categories")
      .select("id, name").eq("is_fallback", true).eq("kind", tgt.kind).maybeSingle();
    if (!fb.data) return json(req, { error: "no_fallback_category" }, 500);
    const fallbackId = (fb.data as { id: string }).id;

    // Reassign expenses + recurring_expenses; the audit trigger will log the
    // category change for each affected expense row.
    const moveExp = await db.from("expenses")
      .update({ category_id: fallbackId })
      .eq("category_id", id);
    if (moveExp.error) return json(req, { error: moveExp.error.message }, 500);
    const moveRec = await db.from("recurring_expenses")
      .update({ category_id: fallbackId })
      .eq("category_id", id);
    if (moveRec.error) return json(req, { error: moveRec.error.message }, 500);

    const del = await db.from("categories").delete().eq("id", id);
    if (del.error) return json(req, { error: del.error.message }, 500);

    log("info", "category_deleted", { id, name: tgt.name, moved_to: fallbackId });
    await recordAudit(sb, {
      actorTelegramId: me.telegram_id,
      actorFamilyMemberId: me.id,
      action: "category_deleted",
      targetId: id,
      targetName: tgt.name,
      details: { moved_to_fallback: fallbackId },
    });
    return json(req, { ok: true, deleted_id: id, moved_to_fallback: fallbackId });
  }

  return json(req, { error: "method_not_allowed" }, 405);
});
