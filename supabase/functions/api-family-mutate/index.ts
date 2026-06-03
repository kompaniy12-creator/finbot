// Admin-only CRUD for family_members. Mirrors the bot's
// /grant /revoke /promote /demote logic so the Mini App can do the same
// from the Settings → Пользователи panel.
//
// POST   /api-family-mutate           { telegram_id, name?, role? }
//   - Adds a new member, or reactivates an existing one with same telegram_id.
//   - role defaults to 'member'. Sends the welcome / restored notification.
//
// PATCH  /api-family-mutate?id=<uuid> { name?, role?, active? }
//   - Edits an existing member. role + active toggles emit audit + notify.
//   - Refuses to demote / deactivate the caller (need one admin alive).
//
// DELETE /api-family-mutate?id=<uuid>
//   - Soft-delete (active=false). Same protections as PATCH.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { forbidden, handleOptions, json, unauthorized } from "../_shared/api_response.ts";
import { recordAudit } from "../_shared/audit.ts";
import { notifyUser } from "../_shared/notify.ts";
import { log } from "../_shared/log.ts";

const PostSchema = z.object({
  telegram_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "member"]).optional(),
});
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "member"]).optional(),
  active: z.boolean().optional(),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  if (me.role !== "admin") return forbidden(req);

  const url = new URL(req.url);

  if (req.method === "POST") {
    let body: z.infer<typeof PostSchema>;
    try {
      body = PostSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const name = (body.name ?? "Member").trim().slice(0, 80) || "Member";
    const role = body.role ?? "member";

    const existing = await sb.from("family_members")
      .select("id, name, role, active")
      .eq("telegram_id", body.telegram_id)
      .maybeSingle();
    if (existing.error) return json(req, { error: existing.error.message }, 500);

    if (existing.data) {
      const row = existing.data as {
        id: string;
        name: string;
        role: string;
        active: boolean;
      };
      if (row.active) {
        return json(req, { error: "already_active", member: row }, 409);
      }
      const upd = await sb.from("family_members")
        .update({ active: true })
        .eq("id", row.id);
      if (upd.error) return json(req, { error: upd.error.message }, 500);
      await recordAudit(sb, {
        actorTelegramId: me.telegram_id,
        actorFamilyMemberId: me.id,
        action: "member_reactivated",
        targetId: row.id,
        targetName: row.name,
        details: { telegram_id: body.telegram_id, role: row.role, via: "mini_app" },
      });
      await notifyUser(
        body.telegram_id,
        `✅ Доступ к FinBot восстановлен. ${row.name}, можешь снова пользоваться ботом.`,
      );
      return json(req, { ok: true, action: "reactivated", member: row });
    }

    const ins = await sb.from("family_members")
      .insert({ name, telegram_id: body.telegram_id, role, active: true })
      .select("id, name, telegram_id, role, active")
      .maybeSingle();
    if (ins.error || !ins.data) {
      return json(req, { error: ins.error?.message ?? "insert_failed" }, 500);
    }
    const newMember = ins.data as {
      id: string;
      name: string;
      telegram_id: number;
      role: string;
      active: boolean;
    };
    await recordAudit(sb, {
      actorTelegramId: me.telegram_id,
      actorFamilyMemberId: me.id,
      action: "member_granted",
      targetId: newMember.id,
      targetName: name,
      details: { telegram_id: body.telegram_id, role, via: "mini_app" },
    });
    await notifyUser(
      body.telegram_id,
      `✅ Доступ к FinBot предоставлен. Привет, ${name}! Напиши /start чтобы начать.`,
    );
    return json(req, { ok: true, action: "granted", member: newMember });
  }

  // PATCH and DELETE both need an existing-row lookup.
  const id = url.searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return json(req, { error: "id_required" }, 400);
  }
  const cur = await sb.from("family_members")
    .select("id, name, telegram_id, role, active")
    .eq("id", id).maybeSingle();
  if (cur.error) return json(req, { error: cur.error.message }, 500);
  if (!cur.data) return json(req, { error: "not_found" }, 404);
  const target = cur.data as {
    id: string;
    name: string;
    telegram_id: number;
    role: string;
    active: boolean;
  };
  // No suicide-cases: don't let the caller demote / revoke themselves and
  // possibly orphan the workspace.
  const isSelf = target.id === me.id;

  if (req.method === "PATCH") {
    let body: z.infer<typeof PatchSchema>;
    try {
      body = PatchSchema.parse(await req.json());
    } catch (_e) {
      return json(req, { error: "bad_request" }, 400);
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== target.name) patch.name = body.name;
    if (body.role !== undefined && body.role !== target.role) {
      if (isSelf && body.role === "member") {
        return json(req, { error: "cannot_demote_self" }, 409);
      }
      patch.role = body.role;
    }
    if (body.active !== undefined && body.active !== target.active) {
      if (isSelf && body.active === false) {
        return json(req, { error: "cannot_revoke_self" }, 409);
      }
      patch.active = body.active;
    }
    if (Object.keys(patch).length === 0) {
      return json(req, { ok: true, member: target, unchanged: true });
    }
    const upd = await sb.from("family_members")
      .update(patch).eq("id", id)
      .select("id, name, telegram_id, role, active").maybeSingle();
    if (upd.error) return json(req, { error: upd.error.message }, 500);

    log("info", "family_member_updated", { id, fields: Object.keys(patch) });
    await recordAudit(sb, {
      actorTelegramId: me.telegram_id,
      actorFamilyMemberId: me.id,
      action: "member_updated",
      targetId: id,
      targetName: target.name,
      details: { fields: Object.keys(patch), via: "mini_app" },
    });

    // User-visible notifications for role / access changes.
    if (patch.role) {
      await notifyUser(
        target.telegram_id,
        patch.role === "admin"
          ? `🛡 Тебе выдана роль администратора FinBot.`
          : `Твоя роль в FinBot изменена на участника.`,
      );
    }
    if (patch.active === true) {
      await notifyUser(
        target.telegram_id,
        `✅ Доступ к FinBot восстановлен. ${target.name}, можешь снова пользоваться ботом.`,
      );
    }
    if (patch.active === false) {
      await notifyUser(target.telegram_id, "🚫 Ваш доступ к FinBot отозван администратором.");
    }
    return json(req, { ok: true, member: upd.data });
  }

  if (req.method === "DELETE") {
    if (isSelf) return json(req, { error: "cannot_revoke_self" }, 409);
    if (!target.active) {
      return json(req, { ok: true, member: target, unchanged: true });
    }
    const upd = await sb.from("family_members").update({ active: false }).eq("id", id);
    if (upd.error) return json(req, { error: upd.error.message }, 500);
    await recordAudit(sb, {
      actorTelegramId: me.telegram_id,
      actorFamilyMemberId: me.id,
      action: "member_revoked",
      targetId: id,
      targetName: target.name,
      details: { telegram_id: target.telegram_id, via: "mini_app" },
    });
    await notifyUser(target.telegram_id, "🚫 Ваш доступ к FinBot отозван администратором.");
    return json(req, { ok: true, deactivated_id: id });
  }

  return json(req, { error: "method_not_allowed" }, 405);
});
