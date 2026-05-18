// Helper for integration tests: send SQL to Supabase via the Management API
// query endpoint. Used in tests gated by RUN_INTEGRATION=1.

const ACCESS_TOKEN = Deno.env.get("SUPABASE_ACCESS_TOKEN");
const PROJECT_REF = Deno.env.get("SUPABASE_PROJECT_REF");

export interface MgmtResult<T = Record<string, unknown>> {
  ok: boolean;
  rows?: T[];
  error?: string;
}

export async function mgmtQuery<T = Record<string, unknown>>(
  sql: string,
): Promise<MgmtResult<T>> {
  if (!ACCESS_TOKEN || !PROJECT_REF) {
    return {
      ok: false,
      error: "SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF missing",
    };
  }
  const resp = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const json = await resp.json();
  if (Array.isArray(json)) {
    return { ok: true, rows: json as T[] };
  }
  return {
    ok: false,
    error: typeof json === "object" && json && "message" in json
      ? String(json.message)
      : "unknown error",
  };
}

export function shouldRunIntegration(): boolean {
  return Deno.env.get("RUN_INTEGRATION") === "1";
}
