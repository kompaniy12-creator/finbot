// Helpers for tenant-aware cron jobs (notifications/summaries). Lets a cron loop
// over every tenant, scope data with tenantDb(sb, tenantId), and deliver to each
// member via THAT tenant's bot token (family bot vs SaaS bot).

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";

export interface CronMember {
  id: string;
  telegram_id: number;
  name: string;
  bot_id: string | null;
  tenant_id: string;
}

export interface CronTenant {
  tenantId: string;
  members: CronMember[];
}

// Map bot_id -> bot token, from the active `bots` registry (token_secret_name is
// resolved from the Edge environment; tokens themselves never live in the DB).
export async function loadBotTokens(sb: SupabaseClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await sb.from("bots").select("id, token_secret_name, active").eq("active", true);
  for (const b of (r.data ?? []) as Array<{ id: string; token_secret_name: string }>) {
    const tok = Deno.env.get(b.token_secret_name);
    if (tok) out.set(b.id, tok);
  }
  return out;
}

// All active members grouped by tenant. Used as the driving list for per-tenant
// notification crons.
export async function loadActiveTenants(sb: SupabaseClient): Promise<CronTenant[]> {
  const r = await sb.from("family_members")
    .select("id, telegram_id, name, bot_id, tenant_id, active")
    .eq("active", true);
  const byTenant = new Map<string, CronMember[]>();
  for (const m of (r.data ?? []) as CronMember[]) {
    if (!m.tenant_id) continue;
    if (!byTenant.has(m.tenant_id)) byTenant.set(m.tenant_id, []);
    byTenant.get(m.tenant_id)!.push(m);
  }
  return [...byTenant.entries()].map(([tenantId, members]) => ({ tenantId, members }));
}

// Send a Telegram message via a specific bot token. Swallows errors (one failed
// DM must not abort the whole cron run).
export async function sendTg(
  token: string | undefined,
  chatId: number,
  text: string,
  event = "cron_tg_failed",
): Promise<boolean> {
  if (!token) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return r.ok;
  } catch (err) {
    log("warn", event, { chat_id: chatId, error: (err as Error).message });
    return false;
  }
}
