import { assertEquals } from "@std/assert";
import { loadEurRates, plnToEur } from "../supabase/functions/_shared/eur_view.ts";

// Minimal SupabaseClient stub: supports the chain we use (from -> select -> eq -> order).
function stubClient(rows: Array<{ rate_date: string; rate_pln: number }>): unknown {
  const builder = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { from: () => builder };
}

Deno.test("loadEurRates: exact-date hit", async () => {
  const sb = stubClient([
    { rate_date: "2026-01-01", rate_pln: 4.30 },
    { rate_date: "2026-01-02", rate_pln: 4.31 },
    { rate_date: "2026-01-03", rate_pln: 4.32 },
  ]);
  const m = await loadEurRates(sb as never, ["2026-01-02"]);
  assertEquals(m.get("2026-01-02"), 4.31);
});

Deno.test("loadEurRates: missing date -> nearest earlier", async () => {
  const sb = stubClient([
    { rate_date: "2026-01-01", rate_pln: 4.30 },
    { rate_date: "2026-01-05", rate_pln: 4.40 },
  ]);
  // 2026-01-03 has no rate; should use 2026-01-01 (nearest earlier).
  const m = await loadEurRates(sb as never, ["2026-01-03"]);
  assertEquals(m.get("2026-01-03"), 4.30);
});

Deno.test("loadEurRates: date before any rate -> nearest later", async () => {
  const sb = stubClient([
    { rate_date: "2026-01-10", rate_pln: 4.50 },
    { rate_date: "2026-01-11", rate_pln: 4.51 },
  ]);
  const m = await loadEurRates(sb as never, ["2026-01-05"]);
  assertEquals(m.get("2026-01-05"), 4.50);
});

Deno.test("loadEurRates: empty rates table -> empty map", async () => {
  const sb = stubClient([]);
  const m = await loadEurRates(sb as never, ["2026-01-05"]);
  assertEquals(m.size, 0);
});

Deno.test("loadEurRates: empty dates input -> empty map (no DB call)", async () => {
  const sb = stubClient([{ rate_date: "2026-01-01", rate_pln: 4.30 }]);
  const m = await loadEurRates(sb as never, []);
  assertEquals(m.size, 0);
});

Deno.test("loadEurRates: dedupes dates and looks up each only once", async () => {
  const sb = stubClient([
    { rate_date: "2026-02-01", rate_pln: 4.30 },
    { rate_date: "2026-02-02", rate_pln: 4.31 },
  ]);
  const m = await loadEurRates(sb as never, [
    "2026-02-01",
    "2026-02-01",
    "2026-02-02",
  ]);
  assertEquals(m.size, 2);
  assertEquals(m.get("2026-02-01"), 4.30);
  assertEquals(m.get("2026-02-02"), 4.31);
});

Deno.test("plnToEur: PLN/rate -> EUR with 2-decimal rounding", () => {
  const m = new Map([["2026-01-01", 4.30]]);
  // 43.00 PLN / 4.30 = 10.00 EUR
  assertEquals(plnToEur(43.0, "2026-01-01", m), 10.0);
  // 10.00 PLN / 4.30 = 2.3255... -> 2.33
  assertEquals(plnToEur(10.0, "2026-01-01", m), 2.33);
});

Deno.test("plnToEur: missing date -> null", () => {
  const m = new Map<string, number>();
  assertEquals(plnToEur(100, "2026-01-01", m), null);
});

Deno.test("plnToEur: zero/negative rate -> null", () => {
  const m = new Map([["2026-01-01", 0]]);
  assertEquals(plnToEur(100, "2026-01-01", m), null);
});
