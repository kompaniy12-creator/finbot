# 11 CODE_TEMPLATES, готовые скелеты часто повторяющихся файлов

Используй эти шаблоны как стартовую точку. Заполняй TODO. Удаляй неактуальные комментарии.

## 1. `deno.json`

```json
{
  "tasks": {
    "test": "deno test --allow-all tests/",
    "fmt": "deno fmt",
    "lint": "deno lint",
    "check": "deno check supabase/functions/**/*.ts",
    "coverage": "bash scripts/check_coverage.sh",
    "validate-env": "bash scripts/validate_env.sh"
  },
  "lint": {
    "rules": { "tags": ["recommended"] },
    "exclude": ["cov", ".supabase", "node_modules"]
  },
  "fmt": {
    "lineWidth": 100,
    "indentWidth": 2,
    "singleQuote": false,
    "exclude": ["cov", ".supabase", "node_modules"]
  },
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": false
  },
  "imports": {
    "@anthropic/sdk": "npm:@anthropic-ai/sdk@0.40.0",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.45.0",
    "grammy": "npm:grammy@1.42.0",
    "groq": "npm:groq-sdk@0.10.0",
    "zod": "npm:zod@3.23.8",
    "sharp": "npm:sharp@0.33.5",
    "heic-convert": "npm:heic-convert@2.1.0",
    "age": "npm:age-encryption@0.1.4",
    "@std/assert": "jsr:@std/assert@1.0.0",
    "@std/testing": "jsr:@std/testing@1.0.0",
    "@std/datetime": "jsr:@std/datetime@0.225.0"
  }
}
```

## 2. `.gitignore`

```
# secrets
.env
.env.local
.env.*.local
*.key
*.pem
*backup-key*

# build & artefacts
/cov/
/dist/
/build/
/tmp/
*.log

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp

# Supabase
/supabase/.temp/
/supabase/.branches/
/supabase/.env

# Deno
.deno/
deno.lock

# node (we shouldn't have but just in case)
/node_modules/
```

## 3. `Makefile`

```makefile
.PHONY: help test fmt lint check coverage deploy logs secrets-push webhook-set bootstrap install-hooks

help:
	@echo "Targets:"
	@echo "  bootstrap     - install required tools (deno, supabase, gh, age)"
	@echo "  install-hooks - install git pre-commit hook"
	@echo "  test          - run deno tests"
	@echo "  fmt           - format code"
	@echo "  lint          - lint code"
	@echo "  check         - type check"
	@echo "  coverage      - run tests with coverage report"
	@echo "  deploy        - apply migrations + deploy functions"
	@echo "  secrets-push  - push .env to Supabase secrets"
	@echo "  webhook-set   - register Telegram webhook"
	@echo "  logs          - tail tg-webhook logs"

bootstrap:
	bash scripts/bootstrap_tools.sh

install-hooks:
	bash scripts/install_git_hooks.sh

test:
	deno task test

fmt:
	deno task fmt

lint:
	deno task lint

check:
	deno task check

coverage:
	bash scripts/check_coverage.sh

deploy:
	supabase db push
	supabase functions deploy --no-verify-jwt

secrets-push:
	supabase secrets set --env-file .env

webhook-set:
	deno run --allow-net --allow-env scripts/setup_telegram_webhook.ts

logs:
	supabase functions logs tg-webhook --tail
```

## 4. Shared utility: `supabase/functions/_shared/log.ts`

```typescript
type Level = "debug" | "info" | "warn" | "error";

export function log(level: Level, event: string, data: Record<string, unknown> = {}): void {
  const safe = maskSecrets(data);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...safe,
  }));
}

function maskSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && /token|secret|key|password/i.test(k) && v.length > 8) {
      result[k] = v.slice(0, 4) + "***" + v.slice(-4);
    } else {
      result[k] = v;
    }
  }
  return result;
}
```

## 5. Shared utility: `supabase/functions/_shared/supabase.ts`

```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (cached) return cached;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
```

## 6. Shared utility: `supabase/functions/_shared/auth.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";

export interface FamilyMember {
  id: string;
  telegram_id: number;
  name: string;
  role: "admin" | "member";
  active: boolean;
}

export async function authorize(
  telegramId: number,
  sb: SupabaseClient,
): Promise<FamilyMember | null> {
  const { data, error } = await sb
    .from("family_members")
    .select("id, telegram_id, name, role, active")
    .eq("telegram_id", telegramId)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    log("error", "authorize_db_error", { telegram_id: telegramId, error: error.message });
    return null;
  }
  return data as FamilyMember | null;
}

export async function notifyAdmin(
  bot: { api: { sendMessage: (id: number, text: string) => Promise<unknown> } },
  text: string,
): Promise<void> {
  const adminId = Number(Deno.env.get("TELEGRAM_ADMIN_TELEGRAM_ID"));
  if (!adminId) return;
  try {
    await bot.api.sendMessage(adminId, text);
  } catch (err) {
    log("error", "notify_admin_failed", { error: (err as Error).message });
  }
}
```

## 7. Shared utility: `supabase/functions/_shared/idempotency.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./log.ts";

/**
 * Returns true if message is fresh (first time we see it), false if already processed.
 * Uses message_log table with primary key (telegram_message_id, family_member_id).
 */
export async function dedupe(
  telegramMessageId: number,
  familyMemberId: string,
  sb: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await sb
    .from("message_log")
    .insert({
      telegram_message_id: telegramMessageId,
      family_member_id: familyMemberId,
      status: "processing",
    })
    .select()
    .maybeSingle();

  if (error) {
    // PostgreSQL unique constraint violation (already exists)
    if (error.code === "23505") {
      log("info", "dedupe_hit", {
        telegram_message_id: telegramMessageId,
        family_member_id: familyMemberId,
      });
      return false;
    }
    log("error", "dedupe_error", { error: error.message });
    return false; // safer to skip on error
  }
  return data !== null;
}

export async function markDone(
  telegramMessageId: number,
  familyMemberId: string,
  sb: SupabaseClient,
): Promise<void> {
  await sb
    .from("message_log")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("telegram_message_id", telegramMessageId)
    .eq("family_member_id", familyMemberId);
}
```

## 8. Shared utility: `supabase/functions/_shared/cors.ts`

```typescript
const TELEGRAM_ORIGIN = "https://web.telegram.org";

function ghPagesOrigin(): string | null {
  const repo = Deno.env.get("GITHUB_REPO");
  if (!repo) return null;
  const owner = repo.split("/")[0];
  return owner ? `https://${owner}.github.io` : null;
}

const allowedOrigins = new Set<string>([
  TELEGRAM_ORIGIN,
  ...(ghPagesOrigin() ? [ghPagesOrigin()!] : []),
]);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = allowedOrigins.has(origin) ? origin : TELEGRAM_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Telegram-Init-Data",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function handleOptions(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
```

## 9. Test helper: `tests/helpers/mock_supabase.ts`

```typescript
// Minimal in-memory mock of Supabase JS client. Implements only methods used by FinBot code.
// Not a full replacement; expand as needed.

type Tables = Record<string, Array<Record<string, unknown>>>;
type Rpcs = Record<string, unknown[]>;

export function mockSupabase(
  seed: { [table: string]: Array<Record<string, unknown>> } = {},
  rpcs: Rpcs = {},
) {
  const tables: Tables = JSON.parse(JSON.stringify(seed));
  const rpcResults = { ...rpcs };
  const events: string[] = [];

  function from(table: string) {
    if (!tables[table]) tables[table] = [];
    return new TableBuilder(table, tables, events);
  }

  function rpc(name: string, _args?: unknown) {
    return Promise.resolve({ data: rpcResults[name] ?? null, error: null });
  }

  return {
    from,
    rpc,
    storage: {
      from(_bucket: string) {
        return {
          upload: async (_path: string, _data: unknown) => ({
            data: { path: "fake" },
            error: null,
          }),
          createSignedUrl: async (_path: string, _ttl: number) => ({
            data: { signedUrl: "https://fake/signed" },
            error: null,
          }),
          remove: async (_paths: string[]) => ({ data: [], error: null }),
        };
      },
    },
    _internal: { tables, events },
  };
}

class TableBuilder {
  private _filter: Array<{ col: string; op: string; val: unknown }> = [];
  private _select = "*";
  private _limit: number | undefined;
  private _orderBy: { col: string; asc: boolean } | undefined;

  constructor(private table: string, private tables: Tables, private events: string[]) {}

  select(cols: string) {
    this._select = cols;
    return this;
  }
  eq(col: string, val: unknown) {
    this._filter.push({ col, op: "eq", val });
    return this;
  }
  gt(col: string, val: unknown) {
    this._filter.push({ col, op: "gt", val });
    return this;
  }
  lt(col: string, val: unknown) {
    this._filter.push({ col, op: "lt", val });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this._filter.push({ col, op: "in", val: vals });
    return this;
  }
  is(col: string, val: unknown) {
    this._filter.push({ col, op: "is", val });
    return this;
  }
  order(col: string, { ascending = true } = {}) {
    this._orderBy = { col, asc: ascending };
    return this;
  }
  limit(n: number) {
    this._limit = n;
    return this;
  }

  private apply(rows: Array<Record<string, unknown>>) {
    let r = rows.filter((row) =>
      this._filter.every((f) => {
        if (f.op === "eq") return row[f.col] === f.val;
        if (f.op === "gt") return (row[f.col] as number) > (f.val as number);
        if (f.op === "lt") return (row[f.col] as number) < (f.val as number);
        if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
        if (f.op === "is") return row[f.col] === f.val;
        return true;
      })
    );
    if (this._orderBy) {
      const ob = this._orderBy;
      r = [...r].sort((a, b) =>
        ob.asc
          ? String(a[ob.col]).localeCompare(String(b[ob.col]))
          : String(b[ob.col]).localeCompare(String(a[ob.col]))
      );
    }
    if (this._limit) r = r.slice(0, this._limit);
    return r;
  }

  async maybeSingle() {
    const rows = this.apply(this.tables[this.table]);
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const rows = this.apply(this.tables[this.table]);
    if (rows.length === 0) return { data: null, error: { message: "no rows" } };
    return { data: rows[0], error: null };
  }

  then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
    const rows = this.apply(this.tables[this.table]);
    return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
  }

  insert(row: Record<string, unknown> | Array<Record<string, unknown>>) {
    const rows = Array.isArray(row) ? row : [row];
    rows.forEach((r) => {
      const withId = {
        id: r.id ?? `mock-${Math.random().toString(36).slice(2, 8)}`,
        created_at: new Date().toISOString(),
        ...r,
      };
      this.tables[this.table].push(withId);
      this.events.push(`insert:${this.table}`);
    });
    return {
      select: () => ({
        maybeSingle: async () => ({ data: rows[rows.length - 1], error: null }),
        single: async () => ({ data: rows[rows.length - 1], error: null }),
      }),
    };
  }

  update(patch: Record<string, unknown>) {
    return {
      eq: (col: string, val: unknown) => {
        const matched = this.tables[this.table].filter((r) => r[col] === val);
        matched.forEach((r) => Object.assign(r, patch));
        this.events.push(`update:${this.table}:${matched.length}`);
        return Promise.resolve({ data: matched, error: null });
      },
    };
  }

  delete() {
    return {
      eq: (col: string, val: unknown) => {
        this.tables[this.table] = this.tables[this.table].filter((r) => r[col] !== val);
        return Promise.resolve({ data: null, error: null });
      },
    };
  }
}
```

## 10. Test helper: `tests/helpers/mock_anthropic.ts`

```typescript
export interface MockAnthropicConfig {
  parseExpenseResponse?: { expenses: Array<Record<string, unknown>> };
  parseReceiptResponse?: Record<string, unknown>;
  categorizeFallbackResponse?: Record<string, unknown>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function mockAnthropic(cfg: MockAnthropicConfig = {}) {
  return {
    messages: {
      create: async (params: { tools?: Array<{ name: string }> }) => {
        const toolName = params.tools?.[0]?.name ?? "unknown";
        const usage = cfg.usage ?? { input_tokens: 100, output_tokens: 50 };
        let input: Record<string, unknown> = {};
        if (toolName === "record_expenses") input = cfg.parseExpenseResponse ?? { expenses: [] };
        if (toolName === "record_receipt") input = cfg.parseReceiptResponse ?? {};
        if (toolName === "assign_category") input = cfg.categorizeFallbackResponse ?? {};
        return {
          content: [{ type: "tool_use", id: "tu_mock", name: toolName, input }],
          usage,
          stop_reason: "tool_use",
          model: "claude-haiku-4-5-20251001",
        };
      },
    },
  };
}
```

## 11. setup-once function

```typescript
// supabase/functions/setup-once/index.ts
import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";

const env = z.object({
  CRON_SECRET: z.string().min(20),
}).parse({ CRON_SECRET: Deno.env.get("CRON_SECRET") });

const CATEGORIES = [
  { name: "Groceries", description: "Food and household groceries from supermarkets" },
  { name: "Cafes and restaurants", description: "Eating out, coffee shops, bars" },
  { name: "Transport", description: "Public transport, taxis, parking" },
  { name: "Fuel", description: "Gasoline, diesel, EV charging" },
  { name: "Housing", description: "Rent, mortgage, utilities, repairs" },
  { name: "Connectivity", description: "Internet, mobile, landline" },
  { name: "Health", description: "Pharmacy, doctors, medical procedures" },
  { name: "Clothing", description: "Apparel, shoes, accessories" },
  { name: "Home goods", description: "Furniture, appliances, household items" },
  { name: "Children", description: "Kids' clothing, toys, school supplies, childcare" },
  { name: "Entertainment", description: "Movies, concerts, games, hobbies" },
  { name: "Subscriptions", description: "Streaming services, software, online services" },
  { name: "Gifts", description: "Presents for others" },
  { name: "Education", description: "Books, courses, school fees" },
  { name: "Travel", description: "Tickets, hotels, vacation expenses" },
  { name: "Taxes and fees", description: "Taxes, government fees, fines" },
  { name: "Other", description: "Miscellaneous", isFallback: true },
];

const FAMILY = [
  // TODO: populated from docs/STATE.md family_members at runtime via X-Setup-Family header
];

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-setup-secret") !== env.CRON_SECRET) {
    return new Response("forbidden", { status: 401 });
  }

  const sb = adminClient();

  // Check if already seeded
  const { count } = await sb.from("categories").select("*", { count: "exact", head: true });
  if ((count ?? 0) >= 17) {
    return new Response(JSON.stringify({ ok: true, message: "already seeded" }), { status: 200 });
  }

  // Seed categories with embeddings
  // @ts-ignore Supabase.ai global
  const session = new Supabase.ai.Session("gte-small");

  for (const cat of CATEGORIES) {
    const embedding = await session.run(cat.description, { mean_pool: true, normalize: true });
    await sb.from("categories").insert({
      name: cat.name,
      description: cat.description,
      embedding,
      is_fallback: cat.isFallback ?? false,
    });
  }

  // Seed family members from X-Setup-Family JSON header
  const familyHeader = req.headers.get("x-setup-family");
  if (familyHeader) {
    const members = JSON.parse(familyHeader);
    await sb.from("family_members").insert(members);
  }

  log("info", "setup_once_completed", { categories: CATEGORIES.length });
  return new Response(JSON.stringify({ ok: true, categories: CATEGORIES.length }), { status: 200 });
});
```

## 12. scripts/setup_telegram_webhook.ts

```typescript
import { z } from "npm:zod@3.23.8";

const env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(40),
  SUPABASE_PROJECT_REF: z.string().min(10),
}).parse({
  TELEGRAM_BOT_TOKEN: Deno.env.get("TELEGRAM_BOT_TOKEN"),
  SUPABASE_PROJECT_REF: Deno.env.get("SUPABASE_PROJECT_REF"),
});

const url =
  `https://${env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1/tg-webhook?secret=${env.TELEGRAM_BOT_TOKEN}`;

const setRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: true,
    max_connections: 40,
  }),
});

const setJson = await setRes.json();
console.log("setWebhook:", JSON.stringify(setJson, null, 2));

const infoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
const infoJson = await infoRes.json();
console.log("getWebhookInfo:", JSON.stringify(infoJson, null, 2));

if (!setJson.ok) Deno.exit(1);
```

---

Конец 11_CODE_TEMPLATES.md.
