import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";
import type { FamilyMember } from "./types.ts";

export async function authorize(
  telegramId: number,
  sb: SupabaseClient,
): Promise<FamilyMember | null> {
  const { data, error } = await sb
    .from("family_members")
    .select("id, tenant_id, bot_id, telegram_id, name, role, active")
    .eq("telegram_id", telegramId)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    log("error", "authorize_db_error", {
      telegram_id: telegramId,
      error: error.message,
    });
    return null;
  }
  return (data as FamilyMember | null) ?? null;
}

export async function notifyAdmin(
  bot: {
    api: { sendMessage: (id: number, text: string) => Promise<unknown> };
  },
  text: string,
): Promise<void> {
  const adminId = Number(Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID"));
  if (!adminId) return;
  try {
    await bot.api.sendMessage(adminId, text);
  } catch (err) {
    log("error", "notify_admin_failed", { error: (err as Error).message });
  }
}
