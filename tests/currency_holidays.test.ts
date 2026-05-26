// Mandatory edge case (SPEC §18.4): currency_holidays.
// NBP returns 404 on weekends/holidays. Our fetcher must walk back to the
// last working day and cache the rate with is_fallback=true.

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { getRate, RateUnavailableError, toPln } from "../supabase/functions/_shared/currency.ts";

interface ExRow {
  rate_date: string;
  currency: string;
  rate_pln: number;
  source: string;
  is_fallback: boolean;
  fallback_from_date?: string | null;
}

function mockSb(initial: ExRow[] = []) {
  const rows: ExRow[] = [...initial];
  const obj = {
    from(_t: string) {
      const builder = {
        _filters: [] as Array<[string, unknown]>,
        _lte: null as [string, string] | null,
        _order: null as [string, boolean] | null,
        _limit: 0,
        select(_c: string) {
          return builder;
        },
        eq(c: string, v: unknown) {
          builder._filters.push([c, v]);
          return builder;
        },
        lte(c: string, v: string) {
          builder._lte = [c, v];
          return builder;
        },
        order(c: string, opts: { ascending: boolean }) {
          builder._order = [c, opts.ascending];
          return builder;
        },
        limit(n: number) {
          builder._limit = n;
          return builder;
        },
        maybeSingle() {
          let filtered = rows.filter((row) =>
            builder._filters.every(([c, v]) => {
              const key = c as keyof ExRow;
              return row[key] === v;
            })
          );
          if (builder._lte) {
            const [c, v] = builder._lte;
            filtered = filtered.filter((row) => (row[c as keyof ExRow] as string) <= v);
          }
          if (builder._order) {
            const [c, asc] = builder._order;
            filtered = filtered.slice().sort((a, b) => {
              const av = String(a[c as keyof ExRow] ?? "");
              const bv = String(b[c as keyof ExRow] ?? "");
              return asc ? av.localeCompare(bv) : bv.localeCompare(av);
            });
          }
          const limited = builder._limit ? filtered.slice(0, builder._limit) : filtered;
          return Promise.resolve({ data: limited[0] ?? null, error: null });
        },
        insert(payload: ExRow) {
          rows.push(payload);
          return Promise.resolve({ data: payload, error: null });
        },
      };
      return builder;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { sb: obj as any, rows };
}

// Replace global fetch for the test.
function withMockedFetch(handler: (url: string) => Response, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test("getRate: PLN always returns 1.0 without DB call", async () => {
  const { sb } = mockSb();
  assertEquals(await getRate(sb, "PLN", "2026-05-19"), 1.0);
});

Deno.test("getRate: cached row returns rate_pln from DB, no fetch", async () => {
  const { sb } = mockSb([
    {
      rate_date: "2026-05-19",
      currency: "EUR",
      rate_pln: 4.30,
      source: "nbp",
      is_fallback: false,
    },
  ]);
  let fetchCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalls++;
    return Promise.reject(new Error("should not fetch"));
  };
  try {
    const rate = await getRate(sb, "EUR", "2026-05-19");
    assertAlmostEquals(rate, 4.30, 1e-9);
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("getRate: NBP 404 on holiday -> walks back to last working day", async () => {
  const { sb, rows } = mockSb();
  // Simulate: 2026-05-17 (Sunday) -> 404. 2026-05-16 (Saturday) -> 404.
  // 2026-05-15 (Friday) -> 200 with mid=4.32.
  await withMockedFetch((url) => {
    if (url.includes("2026-05-15")) {
      return new Response(JSON.stringify({ rates: [{ mid: 4.32 }] }), { status: 200 });
    }
    return new Response("404", { status: 404 });
  }, async () => {
    const rate = await getRate(sb, "EUR", "2026-05-17");
    assertAlmostEquals(rate, 4.32, 1e-9);
    // The cache row uses the REQUESTED date (2026-05-17) but is_fallback=true
    // and fallback_from_date=2026-05-15 records where the rate was actually pulled.
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.rate_date, "2026-05-17");
    assertEquals(rows[0]!.is_fallback, true);
    assertEquals(rows[0]!.fallback_from_date, "2026-05-15");
  });
});

Deno.test("getRate: NBP 200 on requested date -> no fallback flag", async () => {
  const { sb, rows } = mockSb();
  await withMockedFetch(
    () => new Response(JSON.stringify({ rates: [{ mid: 4.50 }] }), { status: 200 }),
    async () => {
      const rate = await getRate(sb, "USD", "2026-05-19");
      assertAlmostEquals(rate, 4.50, 1e-9);
      assertEquals(rows[0]!.is_fallback, false);
      assertEquals(rows[0]!.fallback_from_date, null);
    },
  );
});

Deno.test("getRate: 14 days of 404 -> RateUnavailableError", async () => {
  const { sb } = mockSb();
  let caughtCurrency: string | null = null;
  await withMockedFetch(
    () => new Response("404", { status: 404 }),
    async () => {
      try {
        await getRate(sb, "EUR", "2026-05-19");
      } catch (e) {
        if (e instanceof RateUnavailableError) {
          caughtCurrency = e.currency;
        }
      }
    },
  );
  assertEquals(caughtCurrency, "EUR");
});

Deno.test("toPln: rounds to 2 decimal places", async () => {
  const { sb } = mockSb([
    {
      rate_date: "2026-05-19",
      currency: "EUR",
      rate_pln: 4.30,
      source: "nbp",
      is_fallback: false,
    },
  ]);
  const r = await toPln(sb, 12.34, "EUR", "2026-05-19");
  // 12.34 * 4.30 = 53.062 -> rounded to 53.06
  assertAlmostEquals(r, 53.06, 1e-9);
});

Deno.test("toPln: PLN passes through unchanged", async () => {
  const { sb } = mockSb();
  assertEquals(await toPln(sb, 99.99, "PLN", "2026-05-19"), 99.99);
});

Deno.test("getRate: ALL via exchangerate.host", async () => {
  const { sb, rows } = mockSb();
  await withMockedFetch(
    (url) => {
      if (url.includes("exchangerate.host")) {
        // 1 PLN = X ALL, we invert. e.g. 1 PLN = 25 ALL -> 1 ALL = 0.04 PLN.
        return new Response(JSON.stringify({ rates: { ALL: 25 } }), { status: 200 });
      }
      return new Response("404", { status: 404 });
    },
    async () => {
      const rate = await getRate(sb, "ALL", "2026-05-19");
      assertAlmostEquals(rate, 0.04, 1e-9);
      assertEquals(rows[0]!.source, "exchangerate.host");
    },
  );
});
