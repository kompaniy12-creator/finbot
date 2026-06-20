// Tiny in-memory mock of the Supabase client for unit tests. Supports the
// subset of the query builder used by tenantDb + crypto_box + onboarding:
// from().select().eq().order().limit().maybeSingle(), insert/update/delete
// (awaited), and rpc(). Backed by a per-table array store.
//
// Not a full PostgREST emulation - just enough for deterministic unit tests.

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

export interface MockSb {
  from(table: string): any;
  rpc(name: string, args?: Row): Promise<{ data: unknown; error: null }>;
  _store: Record<string, Row[]>;
}

export function makeMockSb(opts: {
  kekBase64?: string;
  seed?: Record<string, Row[]>;
} = {}): MockSb {
  const store: Record<string, Row[]> = opts.seed ?? {};

  function from(table: string) {
    if (!store[table]) store[table] = [];
    const rows = store[table];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];

    const match = (r: Row) => filters.every(([k, v]) => r[k] === v);

    const builder: Row = {
      select() {
        op = "select";
        return builder;
      },
      insert(p: Row) {
        op = "insert";
        payload = p;
        return builder;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows.filter(match)[0] ?? null, error: null });
      },
      // Awaiting the builder applies a write (insert/update/delete).
      then(resolve: (v: { data: unknown; error: null }) => void) {
        if (op === "insert") {
          rows.push({ ...payload });
        } else if (op === "update") {
          for (const r of rows.filter(match)) Object.assign(r, payload);
        } else if (op === "delete") {
          for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i]!)) rows.splice(i, 1);
        }
        resolve({ data: null, error: null });
      },
    };
    return builder;
  }

  function rpc(name: string, _args?: Row): Promise<{ data: unknown; error: null }> {
    if (name === "get_kek") return Promise.resolve({ data: opts.kekBase64 ?? null, error: null });
    return Promise.resolve({ data: null, error: null });
  }

  return { from, rpc, _store: store };
}
