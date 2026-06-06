// Recompute the embedding centroid for one category from its
// corrected_by_user=true expense rows. Called inline after a user-driven
// correction (Mini App recategorize, bot catset callback) so the next kNN
// query already benefits, without waiting for the weekly cron.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantDb } from "./tenant_db.ts";
import { log } from "./log.ts";

const MIN_CORRECTED = 3;

function parseEmbedding(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return parsed as number[];
      } catch {
        /* fallthrough */
      }
    }
  }
  return null;
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

/**
 * Recompute one category's centroid from its corrected_by_user rows.
 * No-op if fewer than MIN_CORRECTED rows. Returns the number of rows used
 * (0 means skipped).
 */
export async function retrainCategory(
  sb: SupabaseClient,
  tenantId: string,
  categoryId: string,
): Promise<number> {
  if (!categoryId) return 0;
  const db = tenantDb(sb, tenantId);
  const expRes = await db
    .from("expenses")
    .select("embedding")
    .eq("category_id", categoryId)
    .eq("corrected_by_user", true)
    .eq("archived", false);
  if (expRes.error) {
    log("warn", "retrain_select_failed", {
      category_id: categoryId,
      error: expRes.error.message,
    });
    return 0;
  }
  const embeds: number[][] = [];
  for (const row of (expRes.data ?? []) as Array<{ embedding: unknown }>) {
    const parsed = parseEmbedding(row.embedding);
    if (parsed && parsed.length > 0) embeds.push(parsed);
  }
  if (embeds.length < MIN_CORRECTED) return 0;

  const centroid = meanEmbedding(embeds);
  const upd = await db
    .from("categories")
    .update({
      embedding: centroid,
      centroid_updated_at: new Date().toISOString(),
    })
    .eq("id", categoryId);
  if (upd.error) {
    log("warn", "retrain_update_failed", {
      category_id: categoryId,
      error: upd.error.message,
    });
    return 0;
  }
  log("info", "retrain_centroid", { category_id: categoryId, n: embeds.length });
  return embeds.length;
}
