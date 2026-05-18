type Level = "debug" | "info" | "warn" | "error";

export function log(
  level: Level,
  event: string,
  data: Record<string, unknown> = {},
): void {
  const safe = maskSecrets(data);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...safe,
  }));
}

function maskSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (
      typeof v === "string" && /token|secret|key|password/i.test(k) &&
      v.length > 8
    ) {
      result[k] = v.slice(0, 4) + "***" + v.slice(-4);
    } else {
      result[k] = v;
    }
  }
  return result;
}
