// Structured logger with secret/PII scrubbing (P1.4).
//
// Two layers of redaction so secrets never reach the logs:
//   1. By field name  - values under keys like *token*, *secret*, *key*,
//      *password*, *api_key* are masked to a short hint.
//   2. By value shape - any string (even in an unexpected field, nested object
//      or array) matching a secret pattern (Anthropic/Groq keys, our v1:/v2:
//      ciphertext, Telegram bot tokens) is redacted.
//
// debug-level logs are dropped in production unless DEBUG_LOGS=1, so verbose
// payloads can't leak from a forgotten debug line.

type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY = /token|secret|key|password|api[_-]?key|authorization|cookie/i;

// Value patterns that must never appear in logs.
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-[redacted]"],
  [/gsk_[A-Za-z0-9]{6,}/g, "gsk_[redacted]"],
  [/\bv[12]:[A-Za-z0-9+/=:_-]{12,}/g, "[encrypted]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[bot-token]"], // Telegram bot token
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-[redacted]"], // generic provider key
];

const MAX_STRING = 500; // truncate long strings (e.g. raw message bodies)

function redactString(s: string): string {
  let out = s;
  for (const [re, repl] of VALUE_PATTERNS) out = out.replace(re, repl);
  if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + "...[truncated]";
  return out;
}

function maskValue(key: string | null, v: unknown, depth: number): unknown {
  if (typeof v === "string") {
    // Field-name based masking: keep a short hint, redact the rest.
    if (key && SENSITIVE_KEY.test(key) && v.length > 8) {
      return v.slice(0, 2) + "***" + v.slice(-2);
    }
    return redactString(v);
  }
  if (Array.isArray(v)) {
    if (depth > 4) return "[deep]";
    return v.map((x) => maskValue(null, x, depth + 1));
  }
  if (v && typeof v === "object") {
    if (depth > 4) return "[deep]";
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = maskValue(k, val, depth + 1);
    }
    return out;
  }
  return v;
}

export function scrub(data: Record<string, unknown>): Record<string, unknown> {
  return maskValue(null, data, 0) as Record<string, unknown>;
}

export function log(
  level: Level,
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (level === "debug" && Deno.env.get("DEBUG_LOGS") !== "1") return;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...scrub(data),
  }));
}
