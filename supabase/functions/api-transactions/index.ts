// GET /api-transactions?limit=N&offset=M&search=...: paginated list.
import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const initData = extractInitData(req);
  if (!initData) return unauthorized(req);
  const sb = adminClient();
  const me = await authenticateInitData(initData, sb);
  if (!me) return unauthorized(req);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
  const search = url.searchParams.get("search") ?? "";

  let q = sb.from("expenses")
    .select(
      "id, name, amount, currency, amount_pln, expense_date, category_id, family_member_id, source, needs_review, needs_confirmation, created_at",
    )
    .eq("archived", false)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (me.role !== "admin") q = q.eq("family_member_id", me.id);
  if (search) q = q.ilike("name", `%${search}%`);
  const res = await q;
  if (res.error) return json(req, { error: res.error.message }, 500);
  return json(req, { items: res.data ?? [], limit, offset });
});
