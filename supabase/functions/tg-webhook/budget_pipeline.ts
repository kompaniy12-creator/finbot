// Text -> budget: parse a free-form message that defines a spending cap
// ("Добавь бюджет уличные животные 150 евро") into a budgets row + a
// budget_categories link. The intent classifier routes here via 'budget'.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { callClaude } from "../_shared/claude.ts";
import {
  buildBudgetSystemPrompt,
  ParseBudgetOutputSchema,
  ParseBudgetTool,
} from "../_shared/prompts/parse_budget.ts";
import { log } from "../_shared/log.ts";

export type BudgetPipelineOutcome =
  | { kind: "parse_failed"; reason: string }
  | { kind: "category_not_found"; wanted: string; available: string[] }
  | {
    kind: "ok";
    budget_id: string;
    category_name: string;
    amount: number;
    currency: string;
    period: string;
  };

interface CatRow {
  id: string;
  name: string;
}

// Match the parsed category name to one of the tenant's expense categories.
// Tolerant: exact (case-insensitive) first, then substring either way.
function matchCategory(wanted: string, cats: CatRow[]): CatRow | null {
  const w = wanted.trim().toLowerCase();
  if (!w) return null;
  return (
    cats.find((c) => c.name.toLowerCase() === w) ??
      cats.find((c) => c.name.toLowerCase().includes(w) || w.includes(c.name.toLowerCase())) ??
      null
  );
}

export async function processBudgetMessage(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  text: string;
}): Promise<BudgetPipelineOutcome> {
  const model = Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-4-5-20251001";

  let resp;
  try {
    resp = await callClaude({
      sb: args.sb,
      familyMemberId: args.member.id,
      tenantId: args.member.tenant_id,
      model,
      system: buildBudgetSystemPrompt(),
      tools: [ParseBudgetTool],
      maxTokens: 256,
      toolChoice: { type: "tool", name: "record_budget" },
      messages: [{ role: "user", content: [{ type: "text", text: args.text }] }],
    });
  } catch (err) {
    log("error", "budget_parse_claude_failed", { error: (err as Error).message });
    return { kind: "parse_failed", reason: (err as Error).message };
  }

  const toolUse = resp.response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.name !== "record_budget") {
    return { kind: "parse_failed", reason: "no_tool_use_block" };
  }
  const parsed = ParseBudgetOutputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    log("warn", "budget_parse_bad_schema", { issues: parsed.error.issues });
    return { kind: "parse_failed", reason: "schema_invalid" };
  }
  const b = parsed.data;
  const db = tenantDb(args.sb, args.member.tenant_id);

  // Budgets cap expense categories, so match against kind='expense'.
  const catsRes = await db.from("categories").select("id, name").eq("kind", "expense");
  const cats = (catsRes.data ?? []) as CatRow[];
  const cat = matchCategory(b.category_name, cats);
  if (!cat) {
    return {
      kind: "category_not_found",
      wanted: b.category_name,
      available: cats.map((c) => c.name),
    };
  }

  const period = b.period ?? "monthly";
  const ins = await db.from("budgets").insert({
    family_member_id: args.member.id,
    name: cat.name,
    amount: b.amount,
    currency: b.currency,
    period,
  }).select("id").maybeSingle();
  if (ins.error || !ins.data) {
    return { kind: "parse_failed", reason: ins.error?.message ?? "insert_failed" };
  }
  const budgetId = (ins.data as { id: string }).id;

  const link = await db.from("budget_categories").insert({
    budget_id: budgetId,
    category_id: cat.id,
  });
  if (link.error) {
    // Roll back the orphan budget so we don't leave a category-less budget.
    await db.from("budgets").delete().eq("id", budgetId);
    return { kind: "parse_failed", reason: link.error.message };
  }

  log("info", "budget_created_from_text", {
    budget_id: budgetId,
    category: cat.name,
    amount: b.amount,
    currency: b.currency,
    period,
  });
  return {
    kind: "ok",
    budget_id: budgetId,
    category_name: cat.name,
    amount: b.amount,
    currency: b.currency,
    period,
  };
}

export function formatBudgetReply(o: BudgetPipelineOutcome): string {
  if (o.kind === "parse_failed") {
    return `Не смог распознать бюджет (${o.reason}). ` +
      `Попробуй: «добавь бюджет еда 2000 PLN в месяц».`;
  }
  if (o.kind === "category_not_found") {
    const list = o.available.slice(0, 20).join(", ");
    return `Не нашёл категорию «${o.wanted}». Доступные категории:\n${list}\n\n` +
      `Повтори с точным названием, например: «бюджет ${
        o.available[0] ?? "Питание продукты"
      } 500 EUR».`;
  }
  const periodRu = o.period === "weekly" ? "в неделю" : o.period === "yearly" ? "в год" : "в месяц";
  const sumStr = Number(o.amount).toFixed(2).replace(/\.00$/, "") + " " + o.currency;
  return `✅ Бюджет создан: ${o.category_name} - ${sumStr} ${periodRu}.\n` +
    `Прогресс смотри во вкладке Планирование -> Бюджеты.`;
}
