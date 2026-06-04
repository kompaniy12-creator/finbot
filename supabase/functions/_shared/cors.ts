const TELEGRAM_ORIGIN = "https://web.telegram.org";

function ghPagesOrigin(): string | null {
  const repo = Deno.env.get("GITHUB_REPO");
  if (!repo) return null;
  const owner = repo.split("/")[0];
  return owner ? `https://${owner}.github.io` : null;
}

export function buildAllowedOrigins(): Set<string> {
  const set = new Set<string>([TELEGRAM_ORIGIN]);
  const gh = ghPagesOrigin();
  if (gh) set.add(gh);
  return set;
}

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = buildAllowedOrigins();
  const origin = req.headers.get("Origin") || "";
  const allow = allowed.has(origin) ? origin : TELEGRAM_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Telegram-Init-Data",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function handleOptions(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
