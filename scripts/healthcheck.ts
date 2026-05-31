// Comprehensive health check: DB integrity, table counts, FK refs,
// data consistency, FX correctness. Read-only. Prints a report.

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string): Promise<unknown> {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: sbKey, authorization: `Bearer ${sbKey}` },
  });
  return await r.json();
}

async function count(path: string): Promise<number> {
  const r = await fetch(`${url}/rest/v1/${path}&select=count`, {
    headers: {
      apikey: sbKey,
      authorization: `Bearer ${sbKey}`,
      prefer: "count=exact",
    },
  });
  const cr = r.headers.get("content-range") ?? "";
  return Number(cr.split("/")[1] ?? "0") || 0;
}

const issues: string[] = [];
function issue(msg: string) {
  issues.push(msg);
  console.log(`  ⚠ ${msg}`);
}
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

// ---- Tables ---------------------------------------------------------------
console.log("\n[1] Table counts");
const tables = [
  "family_members",
  "categories",
  "expenses",
  "receipts",
  "expense_audit",
  "system_audit",
  "exchange_rates",
  "anthropic_usage",
  "recurring_expenses",
  "rate_limit",
  "pending_access",
  "ask_proposals",
  "message_log",
];
for (const t of tables) {
  try {
    const n = await count(`${t}?archived=is.null,archived=eq.false`);
    // The archived filter doesn't exist on all tables, so use a no-op fallback
    const total = await count(`${t}?id=not.is.null`);
    ok(`${t}: ${total} rows`);
  } catch (e) {
    issue(`${t}: ${(e as Error).message}`);
  }
}

// ---- FK / orphan checks ---------------------------------------------------
console.log("\n[2] FK + orphan checks");

// expenses without a category (should be 0; category_id is NOT NULL)
const noCat = await rest(
  "expenses?category_id=is.null&select=id&limit=1",
) as Array<unknown>;
if (noCat.length === 0) ok("all expenses have category_id");
else issue(`${noCat.length} expenses missing category_id`);

// expenses with category_id pointing to a deleted category
const cats = (await rest("categories?select=id")) as Array<{ id: string }>;
const catIds = new Set(cats.map((c) => c.id));
const sampleExp = (await rest(
  "expenses?archived=eq.false&select=id,category_id&limit=500",
)) as Array<{ id: string; category_id: string }>;
const orphCat = sampleExp.filter((e) => !catIds.has(e.category_id));
if (orphCat.length === 0) ok(`${sampleExp.length} sampled expenses: all category refs valid`);
else issue(`${orphCat.length} expenses point to a non-existent category`);

// receipts with expense lines missing
const receipts = (await rest(
  "receipts?archived=eq.false&select=id,merchant&limit=300",
)) as Array<{ id: string; merchant: string | null }>;
const recIds = receipts.map((r) => r.id);
let receiptsWithoutLines = 0;
for (const rid of recIds) {
  const c = await count(`expenses?receipt_id=eq.${rid}&archived=eq.false`);
  if (c === 0) receiptsWithoutLines++;
}
if (receiptsWithoutLines === 0) {
  ok(`${recIds.length} active receipts all have at least one line`);
} else issue(`${receiptsWithoutLines} active receipts have no expense lines`);

// expenses with receipt_id pointing to nothing
const recExp = (await rest(
  "expenses?archived=eq.false&receipt_id=not.is.null&select=id,receipt_id&limit=500",
)) as Array<{ id: string; receipt_id: string }>;
const recIdSet = new Set(recIds);
const orphRec = recExp.filter((e) => !recIdSet.has(e.receipt_id));
if (orphRec.length === 0) ok(`${recExp.length} expense rows: receipt refs valid`);
else issue(`${orphRec.length} expenses point to deleted receipts`);

// ---- amount_pln correctness check ----------------------------------------
console.log("\n[3] amount_pln cross-check");

// For each currency, fetch sample expenses and compare amount_pln to amount * rate
const ccyExp = (await rest(
  "expenses?archived=eq.false&currency=neq.PLN&select=id,amount,currency,amount_pln,expense_date&order=created_at.desc&limit=200",
)) as Array<{
  id: string;
  amount: number;
  currency: string;
  amount_pln: number;
  expense_date: string;
}>;

let rateMissing = 0;
let rateMismatch = 0;
let perfectRate = 0;
const rateCache = new Map<string, number | null>();
async function rateFor(currency: string, date: string): Promise<number | null> {
  const key = `${currency}|${date}`;
  if (rateCache.has(key)) return rateCache.get(key)!;
  const r = (await rest(
    `exchange_rates?currency=eq.${currency}&rate_date=lte.${date}&order=rate_date.desc&limit=1&select=rate_pln`,
  )) as Array<{ rate_pln: number }>;
  const v = r[0] ? Number(r[0].rate_pln) : null;
  rateCache.set(key, v);
  return v;
}
for (const e of ccyExp) {
  const rate = await rateFor(e.currency, e.expense_date);
  if (!rate) {
    rateMissing++;
    continue;
  }
  const expected = Math.round(Number(e.amount) * rate * 100) / 100;
  const diff = Math.abs(expected - Number(e.amount_pln));
  if (diff < 0.05) perfectRate++;
  else if (Number(e.amount_pln) === Number(e.amount)) {
    rateMismatch++; // suspect rate-fallback-to-1.0
  } else {
    // allow small drift (rate fluctuation or different fallback date)
    // (don't count as issue unless dramatically off)
    if (Math.abs(expected - Number(e.amount_pln)) > expected * 0.05) {
      rateMismatch++;
    } else perfectRate++;
  }
}
ok(`${perfectRate}/${ccyExp.length} non-PLN expenses have plausible amount_pln`);
if (rateMissing > 0) issue(`${rateMissing} expenses have no EUR rate available for their date`);
if (rateMismatch > 0) {
  issue(
    `${rateMismatch} non-PLN expenses have amount_pln == amount (rate fallback fired) or > 5% off expected`,
  );
}

// ---- Categories: embeddings ----------------------------------------------
console.log("\n[4] Categories");
const catsEmb = (await rest(
  "categories?select=id,name,is_fallback,embedding&order=name.asc",
)) as Array<{ id: string; name: string; is_fallback: boolean; embedding: unknown }>;
const noEmb = catsEmb.filter((c) => !c.embedding);
if (noEmb.length === 0) ok(`${catsEmb.length} categories all have embeddings`);
else issue(`${noEmb.length} categories missing embedding: ${noEmb.map((c) => c.name).join(", ")}`);
const fallbacks = catsEmb.filter((c) => c.is_fallback);
if (fallbacks.length === 1) ok(`exactly 1 fallback category: "${fallbacks[0]!.name}"`);
else if (fallbacks.length === 0) issue("no fallback category set");
else issue(`${fallbacks.length} categories marked as fallback (must be exactly 1)`);

// ---- Family ---------------------------------------------------------------
console.log("\n[5] Family members");
const fam = (await rest(
  "family_members?select=id,name,telegram_id,role,active",
)) as Array<{ id: string; name: string; telegram_id: number; role: string; active: boolean }>;
const admins = fam.filter((m) => m.role === "admin" && m.active);
const members = fam.filter((m) => m.role === "member" && m.active);
ok(`${fam.length} total: ${admins.length} active admin(s), ${members.length} active member(s)`);
if (admins.length === 0) issue("NO active admin - bot has no one in charge");

// ---- Settings -------------------------------------------------------------
console.log("\n[6] Settings (functions_url + cron_secret)");
const settings = (await rest("settings?select=key,value")) as Array<{ key: string; value: string }>;
const ksMap = new Map(settings.map((s) => [s.key, s.value]));
if (ksMap.get("functions_url")?.includes("supabase.co")) {
  ok(`functions_url: ${ksMap.get("functions_url")}`);
} else issue(`functions_url looks wrong: "${ksMap.get("functions_url")}"`);
if (ksMap.get("cron_secret") && ksMap.get("cron_secret")!.length >= 20) {
  ok("cron_secret: present");
} else issue("cron_secret missing or too short");

// ---- Recent activity audit ------------------------------------------------
console.log("\n[7] Recent activity (last 24h)");
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const expAudit24 = await count(`expense_audit?created_at=gte.${since}`);
const sysAudit24 = await count(`system_audit?created_at=gte.${since}`);
ok(`expense_audit: ${expAudit24} rows in last 24h`);
ok(`system_audit: ${sysAudit24} rows in last 24h`);

const pendingAccess = await count(`pending_access?id=not.is.null`);
ok(`pending_access requests waiting: ${pendingAccess}`);

const askPropPending = await count(`ask_proposals?status=eq.pending`);
ok(`ask_proposals pending: ${askPropPending}`);

// ---- Summary --------------------------------------------------------------
console.log("\n===================================");
if (issues.length === 0) {
  console.log(`✅ All checks passed. Database is healthy.`);
} else {
  console.log(`⚠ ${issues.length} issue(s) found:`);
  for (const i of issues) console.log(`   - ${i}`);
}
