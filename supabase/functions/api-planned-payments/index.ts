// Planned-payments CRUD for the Mini App's "📅 План" tab.
//
//   GET    /api-planned-payments[?kind=expense|income|all]
//   POST   /api-planned-payments              { name, amount, currency, ... }
//   PATCH  /api-planned-payments?id=<uuid>    { ...partial }
//   DELETE /api-planned-payments?id=<uuid>
//
// Family-wide reads (anyone in the family sees every planned payment).
// Writes are owner-or-admin: a member can mutate their own rows; admin
// can mutate anyone's. Matches the policy used by api-delete-item and
// api-recategorize for consistency.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { log } from "../_shared/log.ts";

const CCY = ["PLN", "EUR", "ALL", "USD"] as const;
const METHOD = ["card", "cash", "transfer"] as const;
const FREQ = ["once", "weekly", "monthly", "yearly"] as const;
const KIND = ["expense", "income"] as const;

const CreateSchema = z.object({
  kind: z.enum(KIND).default("expense"),
  name: z.string().min(1).max(120),
  amount: z.number().positive(),
  currency: z.enum(CCY),
  category_id: z.string().uuid().nullable().optional(),
  payment_method: z.enum(METHOD).default("cash"),
  frequency: z.enum(FREQ).default("once"),
  next_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  auto_confirm: z.boolean().default(false),
  notify_on_day: z.boolean().default(true),
  notify_3d_before: z.boolean().default(true),
  note: z.string().max(500).nullable().optional(),
});

const UpdateSchema = CreateSchema.partial().extend({
  active: z.boolean().optional(),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  const db = tenantDb(sb, me.tenant_id);

  const url = new URL(req.url);

  if (req.method === "GET") {
    const kind = url.searchParams.get("kind") ?? "all";
    let q = db.from("planned_payments")
      .select(
        "id, family_member_id, kind, name, amount, currency, category_id, payment_method, frequency, next_due_date, auto_confirm, notify_on_day, notify_3d_before, note, active, last_executed_date, created_at",
      )
      .eq("active", true)
      .order("next_due_date", { ascending: true });
    if (kind === "expense" || kind === "income") q = q.eq("kind", kind);
    const res = await q;
    if (res.error) return json(req, { error: res.error.message }, 500);
    return json(req, { items: res.data ?? [] });
  }

  if (req.method === "POST") {
    let body: z.infer<typeof CreateSchema>;
    try {
      body = CreateSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const ins = await db.from("planned_payments").insert({
      family_member_id: me.id,
      kind: body.kind,
      name: body.name,
      amount: body.amount,
      currency: body.currency,
      category_id: body.category_id ?? null,
      payment_method: body.payment_method,
      frequency: body.frequency,
      next_due_date: body.next_due_date,
      auto_confirm: body.auto_confirm,
      notify_on_day: body.notify_on_day,
      notify_3d_before: body.notify_3d_before,
      note: body.note ?? null,
    }).select("*").maybeSingle();
    if (ins.error) return json(req, { error: ins.error.message }, 500);
    log("info", "planned_payment_created", { id: (ins.data as { id: string }).id });
    return json(req, { ok: true, item: ins.data });
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

    const before = await db.from("planned_payments")
      .select("id, family_member_id").eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const ownerId = (before.data as { family_member_id: string }).family_member_id;
    if (ownerId !== me.id && me.role !== "admin") return forbidden(req);

    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(body) as (keyof z.infer<typeof UpdateSchema>)[]) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) {
      return json(req, { ok: true, unchanged: true });
    }
    patch.updated_at = new Date().toISOString();
    const upd = await db.from("planned_payments").update(patch).eq("id", id)
      .select("*").maybeSingle();
    if (upd.error) return json(req, { error: upd.error.message }, 500);
    log("info", "planned_payment_updated", { id, fields: Object.keys(patch) });
    return json(req, { ok: true, item: upd.data });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "id_required" }, 400);

    const before = await db.from("planned_payments")
      .select("id, family_member_id").eq("id", id).maybeSingle();
    if (!before.data) return json(req, { error: "not_found" }, 404);
    const ownerId = (before.data as { family_member_id: string }).family_member_id;
    if (ownerId !== me.id && me.role !== "admin") return forbidden(req);

    const del = await db.from("planned_payments").delete().eq("id", id);
    if (del.error) return json(req, { error: del.error.message }, 500);
    log("info", "planned_payment_deleted", { id });
    return json(req, { ok: true, deleted_id: id });
  }

  return json(req, { error: "method_not_allowed" }, 405);
});
