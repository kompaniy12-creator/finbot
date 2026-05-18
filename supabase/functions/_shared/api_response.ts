// Shared HTTP helpers for api-* endpoints.

import { corsHeaders, handleOptions } from "./cors.ts";

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function text(
  req: Request,
  body: string,
  status = 200,
  contentType = "text/plain",
): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders(req), "Content-Type": contentType },
  });
}

export function unauthorized(req: Request): Response {
  return json(req, { error: "unauthorized" }, 401);
}

export function forbidden(req: Request): Response {
  return json(req, { error: "forbidden" }, 403);
}

export { handleOptions };
