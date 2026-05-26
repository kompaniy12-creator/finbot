// Unit tests for _shared/categorizer.ts (kNN -> Claude fallback pipeline).
import { assertEquals } from "@std/assert";
import {
  categorize,
  type CategorizeDeps,
  type CategoryRow,
  type FallbackResolver,
  type SimilarExpenseRow,
} from "../supabase/functions/_shared/categorizer.ts";
import type { EmbedFn } from "../supabase/functions/_shared/embedder.ts";

type Row = Record<string, unknown>;

function makeSb(opts: {
  rpcMatches?: SimilarExpenseRow[];
  categories?: CategoryRow[];
  insertResult?: { id: string };
}) {
  const inserted: Row[] = [];
  const sb = {
    rpc(_name: string, _args: unknown) {
      return Promise.resolve({ data: opts.rpcMatches ?? [], error: null });
    },
    from(_table: string) {
      const obj = {
        _filter: [] as Array<[string, unknown]>,
        select(_: string) {
          return obj;
        },
        eq(c: string, v: unknown) {
          obj._filter.push([c, v]);
          return obj;
        },
        order(_c: string, _o: unknown) {
          return obj;
        },
        limit(_n: number) {
          return obj;
        },
        maybeSingle() {
          if (opts.insertResult) {
            return Promise.resolve({ data: opts.insertResult, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(onFulfilled: (v: unknown) => unknown) {
          return Promise.resolve({ data: opts.categories ?? [], error: null }).then(
            onFulfilled,
          );
        },
        insert(payload: Row) {
          inserted.push(payload);
          return {
            select() {
              return {
                maybeSingle() {
                  return Promise.resolve({
                    data: opts.insertResult ?? { id: "new-cat-id" },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
      return obj;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { sb: sb as any, inserted };
}

const stubEmbed: EmbedFn = (text: string) => {
  // Deterministic 384-dim "embedding": all zeros with one 1.0 based on length parity.
  const v = new Array(384).fill(0);
  v[text.length % 384] = 1;
  return Promise.resolve(v);
};

const stubFallback = (
  decision:
    | { kind: "existing"; categoryId: string }
    | { kind: "new"; name: string; description: string },
): FallbackResolver =>
(_args) => Promise.resolve(decision);

Deno.test("categorizer: kNN hit above threshold returns top-1 category", async () => {
  const { sb } = makeSb({
    rpcMatches: [
      { id: "e1", name: "milk", category_id: "cat-groceries", similarity: 0.92 },
      { id: "e2", name: "bread", category_id: "cat-groceries", similarity: 0.88 },
    ],
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({ kind: "existing", categoryId: "should-not-be-called" }),
  };
  const out = await categorize(deps, {
    name: "молоко",
    nameNormalizedEn: "milk 2 percent",
    familyMemberId: "fm-1",
  });
  assertEquals(out.method, "knn");
  assertEquals(out.categoryId, "cat-groceries");
  assertEquals(out.similarity, 0.92);
});

Deno.test("categorizer: kNN below threshold falls back to Claude (existing)", async () => {
  const { sb } = makeSb({
    rpcMatches: [], // RPC returns no rows above threshold
    categories: [
      { id: "cat-misc", name: "Other", description: "misc", is_fallback: true },
      { id: "cat-groceries", name: "Groceries", description: "food", is_fallback: false },
    ],
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({ kind: "existing", categoryId: "cat-groceries" }),
  };
  const out = await categorize(deps, {
    name: "необычный товар",
    nameNormalizedEn: "unusual item",
    familyMemberId: "fm-1",
  });
  assertEquals(out.method, "claude");
  assertEquals(out.categoryId, "cat-groceries");
});

Deno.test("categorizer: Claude returns new category -> inserted", async () => {
  const { sb, inserted } = makeSb({
    rpcMatches: [],
    categories: [
      { id: "cat-misc", name: "Other", description: "misc", is_fallback: true },
    ],
    insertResult: { id: "brand-new-cat" },
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({
      kind: "new",
      name: "Pets",
      description: "Pet food, vet, accessories",
    }),
  };
  const out = await categorize(deps, {
    name: "корм для собак",
    nameNormalizedEn: "dog food",
    familyMemberId: "fm-1",
  });
  assertEquals(out.method, "new");
  assertEquals(out.categoryId, "brand-new-cat");
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0]!.name, "Pets");
});

Deno.test("categorizer: kNN exactly AT lower threshold does NOT count as hit (must be >)", async () => {
  const { sb } = makeSb({
    rpcMatches: [
      { id: "e1", name: "x", category_id: "cat-x", similarity: 0.70 },
    ],
    categories: [{ id: "cat-fallback", name: "Other", description: "x", is_fallback: true }],
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({ kind: "existing", categoryId: "cat-fallback" }),
  };
  const out = await categorize(deps, {
    name: "x",
    nameNormalizedEn: "x",
    familyMemberId: "fm-1",
  });
  assertEquals(out.method, "claude", "AT threshold should defer to fallback");
});

Deno.test("categorizer: medium-confidence band (kNN hit between 0.70 and 0.92)", async () => {
  const { sb } = makeSb({
    rpcMatches: [
      { id: "e1", name: "x", category_id: "cat-x", similarity: 0.85 },
    ],
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({ kind: "existing", categoryId: "cat-x" }),
  };
  const out = await categorize(deps, {
    name: "x",
    nameNormalizedEn: "x",
    familyMemberId: "fm-1",
  });
  assertEquals(out.method, "knn");
  assertEquals(out.confidence, "medium", "0.85 sits between 0.70 and 0.92 -> medium");
});

Deno.test("categorizer: high-confidence band (kNN hit above 0.92)", async () => {
  const { sb } = makeSb({
    rpcMatches: [
      { id: "e1", name: "x", category_id: "cat-x", similarity: 0.95 },
    ],
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({ kind: "existing", categoryId: "cat-x" }),
  };
  const out = await categorize(deps, {
    name: "x",
    nameNormalizedEn: "x",
    familyMemberId: "fm-1",
  });
  assertEquals(out.method, "knn");
  assertEquals(out.confidence, "high");
});

Deno.test("categorizer: low-confidence band (Claude fallback)", async () => {
  const { sb } = makeSb({
    rpcMatches: [],
    categories: [{ id: "cat-fallback", name: "Other", description: "x", is_fallback: true }],
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({ kind: "existing", categoryId: "cat-fallback" }),
  };
  const out = await categorize(deps, {
    name: "x",
    nameNormalizedEn: "x",
    familyMemberId: "fm-1",
  });
  assertEquals(out.method, "claude");
  assertEquals(out.confidence, "low");
});

Deno.test("categorizer: returns embedding for caller storage", async () => {
  const { sb } = makeSb({
    rpcMatches: [
      { id: "e1", name: "x", category_id: "cat-x", similarity: 0.99 },
    ],
  });
  const deps: CategorizeDeps = {
    sb,
    embedFn: stubEmbed,
    fallback: stubFallback({ kind: "existing", categoryId: "cat-x" }),
  };
  const out = await categorize(deps, {
    name: "x",
    nameNormalizedEn: "x",
    familyMemberId: "fm-1",
  });
  assertEquals(out.embedding.length, 384);
});
