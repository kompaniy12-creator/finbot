// GET /api-health-public: 200 if heartbeat is fresh (<5 min), else 503.
// No auth, used by UptimeRobot.
import { adminClient } from "../_shared/supabase.ts";

Deno.serve(async (_req: Request) => {
  const sb = adminClient();
  const res = await sb.from("system_health").select("last_seen").eq("id", 1).maybeSingle();
  const lastSeen = (res.data as { last_seen: string } | null)?.last_seen;
  if (!lastSeen) return new Response("no heartbeat", { status: 503 });
  const ageMin = (Date.now() - new Date(lastSeen).getTime()) / 60_000;
  if (ageMin > 5) return new Response(`stale: ${ageMin.toFixed(1)}m`, { status: 503 });
  return new Response("ok", { status: 200 });
});
