// Categorizer pipeline per SPEC §7.3.
//   1. Claude normalised the item name to English (name_normalized_en).
//   2. embed(name_normalized_en) -> 384-dim vector via gte-small.
//   3. match_expenses RPC with threshold 0.85.
//   4. If hit -> use top-1 category_id.
//   5. Else -> Claude fallback with top-30 categories + top-5 similar expenses,
//      Claude returns category_id (existing) or a new category.
//   6. New category -> insert with embedding on English description.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbedFn } from "./embedder.ts";
import { log } from "./log.ts";

export const KNN_THRESHOLD = 0.85;
export const KNN_TOP_K = 5;
export const FALLBACK_TOP_CATEGORIES = 30;
export const FALLBACK_SIMILAR_EXAMPLES = 5;

export interface CategorizeInput {
  name: string;
  nameNormalizedEn: string;
  familyMemberId: string;
}

export type CategorizeMethod = "knn" | "claude" | "new";

export interface CategorizeOutput {
  categoryId: string;
  method: CategorizeMethod;
  similarity?: number;
  embedding: number[];
}

export interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  is_fallback: boolean;
}

export interface SimilarExpenseRow {
  id: string;
  name: string;
  category_id: string;
  similarity: number;
}

export type FallbackResolver = (args: {
  itemName: string;
  itemNormalizedEn: string;
  topCategories: CategoryRow[];
  similarExamples: SimilarExpenseRow[];
}) => Promise<
  | {
    kind: "existing";
    categoryId: string;
  }
  | {
    kind: "new";
    name: string;
    description: string;
  }
>;

export interface CategorizeDeps {
  sb: SupabaseClient;
  embedFn: EmbedFn;
  fallback: FallbackResolver;
}

export async function categorize(
  deps: CategorizeDeps,
  input: CategorizeInput,
): Promise<CategorizeOutput> {
  const embedding = await deps.embedFn(input.nameNormalizedEn);

  // 1. kNN via match_expenses RPC.
  const rpc = await deps.sb.rpc("match_expenses", {
    query_embedding: embedding,
    family_id: input.familyMemberId,
    match_threshold: KNN_THRESHOLD,
    match_count: KNN_TOP_K,
  });
  const matches = (rpc.data ?? []) as SimilarExpenseRow[];

  if (matches.length > 0 && matches[0]!.similarity > KNN_THRESHOLD) {
    log("info", "categorizer_knn_hit", {
      similarity: matches[0]!.similarity,
      category_id: matches[0]!.category_id,
    });
    return {
      categoryId: matches[0]!.category_id,
      method: "knn",
      similarity: matches[0]!.similarity,
      embedding,
    };
  }

  // 2. Claude fallback: load top-N categories by usage_count + top-5 similar
  //    expenses (regardless of threshold).
  const cats = await deps.sb
    .from("categories")
    .select("id, name, description, is_fallback")
    .order("usage_count", { ascending: false })
    .limit(FALLBACK_TOP_CATEGORIES);
  const topCategories = (cats.data ?? []) as CategoryRow[];

  const similarTop = (matches.slice(0, FALLBACK_SIMILAR_EXAMPLES)) as SimilarExpenseRow[];

  const decision = await deps.fallback({
    itemName: input.name,
    itemNormalizedEn: input.nameNormalizedEn,
    topCategories,
    similarExamples: similarTop,
  });

  if (decision.kind === "existing") {
    log("info", "categorizer_claude_existing", { category_id: decision.categoryId });
    return {
      categoryId: decision.categoryId,
      method: "claude",
      embedding,
    };
  }

  // 3. New category: insert with embedding from English description.
  const catEmbedding = await deps.embedFn(decision.description);
  const ins = await deps.sb.from("categories").insert({
    name: decision.name,
    description: decision.description,
    embedding: catEmbedding,
    is_fallback: false,
  }).select("id").maybeSingle();

  if (ins.error || !ins.data) {
    log("error", "categorizer_new_insert_failed", {
      error: ins.error?.message ?? "no data",
    });
    // Fall back to "Other"
    const other = topCategories.find((c) => c.is_fallback);
    return {
      categoryId: other?.id ?? "",
      method: "new",
      embedding,
    };
  }

  log("info", "categorizer_new_inserted", { name: decision.name });
  return {
    categoryId: (ins.data as { id: string }).id,
    method: "new",
    embedding,
  };
}

/**
 * Increment usage_count for a category. Called after every successful expense insert.
 */
export async function bumpCategoryUsage(
  sb: SupabaseClient,
  categoryId: string,
): Promise<void> {
  // Use a single SQL UPDATE rather than read-modify-write to avoid races.
  const { error } = await sb.rpc("increment_category_usage", { cat_id: categoryId });
  if (error) {
    // No RPC yet: best-effort fallback to a non-atomic update.
    const cur = await sb.from("categories").select("usage_count").eq("id", categoryId)
      .maybeSingle();
    const next = ((cur.data as { usage_count: number } | null)?.usage_count ?? 0) + 1;
    await sb.from("categories").update({ usage_count: next }).eq("id", categoryId);
  }
}
