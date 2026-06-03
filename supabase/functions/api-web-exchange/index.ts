// POST /api-web-exchange { magic: "<token>" }
//
// Exchanges a one-time magic-link token (5 min TTL, issued by the bot /web
// command) for a durable session token (24 h TTL) that the browser stores in
// localStorage and sends as Authorization: Bearer <token> on subsequent
// api-* calls. See migration 0017_web_sessions.sql for the table.
//
// Concurrency: the exchange uses an UPDATE with explicit WHERE-not-consumed
// guard so two clicks on the same link race to a single winner.
import { adminClient } from "../_shared/supabase.ts";
import { handleOptions, json } from "../_shared/api_response.ts";

const SESSION_TTL_HOURS = 24;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  if (req.method !== "POST") {
    return json(req, { error: "method_not_allowed" }, 405);
  }

  let body: { magic?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "bad_json" }, 400);
  }
  const magic = typeof body.magic === "string" ? body.magic.trim() : "";
  if (!magic || !/^[0-9a-f]{32,128}$/i.test(magic)) {
    return json(req, { error: "bad_magic" }, 400);
  }

  const sb = adminClient();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") || null;
  const userAgent = req.headers.get("user-agent")?.slice(0, 256) ?? null;

  // Look up the magic row.
  const row = await sb
    .from("web_sessions")
    .select("id, family_member_id, magic_expires_at, magic_consumed_at")
    .eq("magic_token", magic)
    .maybeSingle();
  if (row.error || !row.data) {
    return json(req, { error: "magic_not_found" }, 401);
  }
  const r = row.data as {
    id: string;
    family_member_id: string;
    magic_expires_at: string | null;
    magic_consumed_at: string | null;
  };
  const nowIso = new Date().toISOString();
  if (!r.magic_expires_at || r.magic_expires_at <= nowIso) {
    return json(req, { error: "magic_expired" }, 401);
  }
  if (r.magic_consumed_at) {
    return json(req, { error: "magic_already_used" }, 401);
  }

  // Mint the durable session token. Concurrency: only update if NOT yet
  // consumed so two parallel exchanges of the same magic resolve to a
  // single winner.
  const sessionToken = randomHex(32);
  const sessionExpiresAt = new Date(
    Date.now() + SESSION_TTL_HOURS * 3600 * 1000,
  ).toISOString();
  const upd = await sb
    .from("web_sessions")
    .update({
      session_token: sessionToken,
      session_expires_at: sessionExpiresAt,
      magic_consumed_at: nowIso,
      magic_token: null,
      last_used_at: nowIso,
      ip,
      user_agent: userAgent,
    })
    .eq("id", r.id)
    .is("magic_consumed_at", null)
    .select("id");
  if (upd.error) {
    return json(req, { error: "db_error", detail: upd.error.message }, 500);
  }
  if (!upd.data || upd.data.length === 0) {
    // Race lost or row already consumed between the read and the write.
    return json(req, { error: "magic_already_used" }, 401);
  }

  return json(req, {
    ok: true,
    session: sessionToken,
    expires_at: sessionExpiresAt,
  });
});
