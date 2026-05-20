// cron-media-group-sweep: every 2 minutes. Picks media_group_id buckets
// older than 30s, dispatches each photo to the photo pipeline (max 5 per
// group per SPEC §6.4), removes processed rows from the buffer.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import { processPhotoMessage } from "../tg-webhook/photo_pipeline.ts";
import { makeEmitterFor } from "../_shared/progress.ts";

const STALE_AGE_SEC = 30;
const MAX_PER_GROUP = 5;

interface BufferRow {
  media_group_id: string;
  telegram_message_id: number;
  family_member_id: string;
  file_id: string;
  received_at: string;
  ack_message_id: number | null;
  chat_id: number | null;
}

interface FamilyMemberRow {
  id: string;
  telegram_id: number;
  name: string;
  role: "admin" | "member";
  active: boolean;
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();
  const cutoff = new Date(Date.now() - STALE_AGE_SEC * 1000).toISOString();

  const all = await sb
    .from("media_group_buffer")
    .select(
      "media_group_id, telegram_message_id, family_member_id, file_id, received_at, ack_message_id, chat_id",
    )
    .lte("received_at", cutoff)
    .order("media_group_id", { ascending: true })
    .order("telegram_message_id", { ascending: true });
  if (all.error) {
    log("error", "mg_sweep_select_failed", { error: all.error.message });
    return new Response("db error", { status: 500 });
  }
  const rows = (all.data ?? []) as BufferRow[];
  if (rows.length === 0) return Response.json({ groups: 0, processed: 0 });

  const byGroup = new Map<string, BufferRow[]>();
  for (const r of rows) {
    const list = byGroup.get(r.media_group_id) ?? [];
    list.push(r);
    byGroup.set(r.media_group_id, list);
  }

  const fmIds = [...new Set(rows.map((r) => r.family_member_id))];
  const fmsRes = await sb.from("family_members").select("id, telegram_id, name, role, active")
    .in("id", fmIds);
  const fmsMap = new Map<string, FamilyMemberRow>(
    ((fmsRes.data ?? []) as FamilyMemberRow[]).map((m) => [m.id, m]),
  );

  let processed = 0;
  let skipped = 0;
  for (const [groupId, items] of byGroup) {
    const fm = fmsMap.get(items[0]!.family_member_id);
    if (!fm) continue;
    const take = items.slice(0, MAX_PER_GROUP);
    if (items.length > MAX_PER_GROUP) {
      skipped += items.length - MAX_PER_GROUP;
    }
    const ackId = items[0]!.ack_message_id;
    const chatId = items[0]!.chat_id;
    const groupProg = (ackId && chatId) ? makeEmitterFor(chatId, ackId) : null;
    let groupProcessed = 0;
    for (let i = 0; i < take.length; i++) {
      const item = take[i]!;
      if (groupProg) {
        await groupProg.update(`📸 Альбом: чек ${i + 1} из ${take.length}...`);
      }
      try {
        await processPhotoMessage({
          sb,
          member: fm,
          fileId: item.file_id,
          telegramMessageId: item.telegram_message_id,
        });
        processed++;
        groupProcessed++;
      } catch (err) {
        log("warn", "mg_sweep_photo_failed", {
          group: groupId,
          file_id: item.file_id,
          error: (err as Error).message,
        });
      }
    }
    if (groupProg) {
      const tail = items.length > MAX_PER_GROUP
        ? ` (последние ${items.length - MAX_PER_GROUP} пропущены, лимит ${MAX_PER_GROUP})`
        : "";
      await groupProg.update(
        `✅ Альбом готов: ${groupProcessed}/${take.length} чеков сохранено${tail}.`,
      );
    }
    await sb.from("media_group_buffer").delete().eq("media_group_id", groupId);
  }

  log("info", "mg_sweep_done", { groups: byGroup.size, processed, skipped });
  return Response.json({ groups: byGroup.size, processed, skipped });
});
