// GET /api-export?period=month|all: CSV of expenses.
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { authenticate } from "../_shared/webapp_auth.ts";
import { handleOptions, text, unauthorized } from "../_shared/api_response.ts";
import { todayWarsawIso } from "../_shared/dates.ts";

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const sb = adminClient();
  const me = await authenticate(req, sb);
  if (!me) return unauthorized(req);
  const db = tenantDb(sb, me.tenant_id);

  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? "month";
  const today = todayWarsawIso();
  const startIso = period === "all" ? "1900-01-01" : today.slice(0, 7) + "-01";

  // Family-wide export: every member can export the full family CSV.
  void me;
  const q = db.from("expenses")
    .select(
      "expense_date, name, amount, currency, amount_pln, category_id, family_member_id, source, needs_review, needs_confirmation",
    )
    .eq("archived", false)
    .gte("expense_date", startIso)
    .order("expense_date", { ascending: true });
  const res = await q;
  if (res.error) {
    return text(req, "error\n" + res.error.message, 500, "text/csv");
  }
  const rows = (res.data ?? []) as Record<string, unknown>[];
  const headers = [
    "expense_date",
    "name",
    "amount",
    "currency",
    "amount_pln",
    "category_id",
    "family_member_id",
    "source",
    "needs_review",
    "needs_confirmation",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  return text(req, lines.join("\n") + "\n", 200, "text/csv");
});
