// Embedder wrapper around Supabase.ai gte-small.
// gte-small produces 384-dim L2-normalized vectors when normalize=true.
//
// IMPORTANT: Supabase.ai is a runtime global only inside Supabase Edge
// Functions. Local Deno tests must inject a fake via embedFn argument.

// deno-lint-ignore no-explicit-any
declare const Supabase: any;

let cachedSession: { run: (text: string, opts: unknown) => Promise<number[]> } | null = null;

function getSession() {
  if (cachedSession) return cachedSession;
  // deno-lint-ignore no-explicit-any
  const SupabaseGlobal = (globalThis as any).Supabase ??
    (typeof Supabase !== "undefined" ? Supabase : null);
  if (!SupabaseGlobal?.ai?.Session) {
    throw new Error(
      "Supabase.ai.Session not available - embedder only runs in Edge Function runtime. " +
        "For tests, use embedWith() with a stub.",
    );
  }
  cachedSession = new SupabaseGlobal.ai.Session("gte-small");
  return cachedSession;
}

export async function embed(text: string): Promise<number[]> {
  const s = getSession();
  if (!s) throw new Error("session unavailable");
  return await s.run(text, { mean_pool: true, normalize: true });
}

/**
 * Embed using an injected function. Used by tests and by categorizer to
 * stay decoupled from the runtime global.
 */
export type EmbedFn = (text: string) => Promise<number[]>;

export function defaultEmbedFn(): EmbedFn {
  return embed;
}

export function resetEmbedderForTests(): void {
  cachedSession = null;
}

/**
 * Cosine similarity for two L2-normalized vectors is the dot product.
 * For non-normalized, this still works (it's just dot, not cosine).
 */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
