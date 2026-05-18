// cron-retraining: weekly Sunday 03:00 UTC.
// For each category, if there are >= 3 user-corrected expenses (corrected_by_user=true),
// recompute categories.embedding as the element-wise mean of those expense embeddings
// and update centroid_updated_at.
//
// Per SPEC §7.4.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";

const MIN_CORRECTED = 3;

interface CategoryRow {
  id: string;
  name: string;
}

interface EmbeddingRow {
  embedding: number[] | string | null;
}

function meanEmbedding(rows: number[][]): number[] {
  if (rows.length === 0) return [];
  const dim = rows[0]!.length;
  const sum = new Array(dim).fill(0);
  for (const v of rows) {
    for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0;
  }
  return sum.map((x) => x / rows.length);
}

function parseEmbedding(raw: EmbeddingRow["embedding"]): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw as number[];
  // pgvector returns text like "[0.1,0.2,...]" via REST sometimes.
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return parsed as number[];
      } catch {
        return null;
      }
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) {
    return new Response("forbidden", { status: 401 });
  }

  const sb = adminClient();

  const catRes = await sb.from("categories").select("id, name").eq("is_fallback", false);
  if (catRes.error) {
    log("error", "retraining_select_categories_failed", { error: catRes.error.message });
    return new Response("db error", { status: 500 });
  }

  let updated = 0;
  let skipped = 0;
  for (const cat of (catRes.data ?? []) as CategoryRow[]) {
    const expRes = await sb
      .from("expenses")
      .select("embedding")
      .eq("category_id", cat.id)
      .eq("corrected_by_user", true)
      .eq("archived", false);
    if (expRes.error) {
      log("warn", "retraining_select_expenses_failed", {
        category_id: cat.id,
        error: expRes.error.message,
      });
      continue;
    }
    const embeds: number[][] = [];
    for (const row of (expRes.data ?? []) as EmbeddingRow[]) {
      const parsed = parseEmbedding(row.embedding);
      if (parsed && parsed.length > 0) embeds.push(parsed);
    }
    if (embeds.length < MIN_CORRECTED) {
      skipped++;
      continue;
    }
    const centroid = meanEmbedding(embeds);
    const upd = await sb
      .from("categories")
      .update({
        embedding: centroid,
        centroid_updated_at: new Date().toISOString(),
      })
      .eq("id", cat.id);
    if (upd.error) {
      log("warn", "retraining_update_failed", {
        category_id: cat.id,
        error: upd.error.message,
      });
    } else {
      updated++;
    }
  }

  log("info", "retraining_done", { updated, skipped });
  return Response.json({ updated, skipped });
});
