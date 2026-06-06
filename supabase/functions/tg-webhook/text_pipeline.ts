// Full text/voice pipeline (SPEC §6.1):
//   Claude parse -> embed (gte-small) -> kNN categorize w/ Claude fallback ->
//   currency convert -> insert expenses -> reply with inline keyboard.
//
// Returns the structured outcome so the webhook handler can format the reply.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { callClaude } from "../_shared/claude.ts";
import {
  buildParseExpensePrompt,
  type ParsedExpenseRow,
  ParseExpenseOutputSchema,
} from "../_shared/prompts/parse_expense.ts";
import { categorize } from "../_shared/categorizer.ts";
import { defaultEmbedFn } from "../_shared/embedder.ts";
import { buildClaudeFallback } from "../_shared/claude_fallback.ts";
import { toPln } from "../_shared/currency.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { log } from "../_shared/log.ts";

const HIGH_AMOUNT_PLN = Number(Deno.env.get("HIGH_AMOUNT_THRESHOLD_PLN") ?? "200");

export interface ProcessedExpense {
  id: string;
  // Optional for backwards-compat with tests + older callers; absence is
  // treated as "expense" everywhere downstream (formatReply, dashboards).
  kind?: "expense" | "income";
  name: string;
  amount: number;
  currency: string;
  amount_pln: number;
  expense_date: string;
  category_name: string;
  needs_confirmation: boolean;
  confidence: "high" | "medium" | "low";
  high_amount: boolean;
}

export interface PipelineResult {
  expenses: ProcessedExpense[];
  warnings: string[];
}

export async function processTextMessage(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  text: string;
  telegramMessageId: number;
}): Promise<PipelineResult | null> {
  const model = Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-4-5-20251001";
  const todayIso = todayWarsawIso();
  const { system, tools } = buildParseExpensePrompt({ todayWarsaw: todayIso });

  let resp;
  try {
    resp = await callClaude({
      sb: args.sb,
      familyMemberId: args.member.id,
      model,
      system,
      tools,
      maxTokens: 1024,
      toolChoice: { type: "tool", name: "record_expenses" },
      messages: [{ role: "user", content: args.text }],
    });
  } catch (err) {
    log("warn", "pipeline_claude_failed", { error: (err as Error).message });
    return null;
  }

  const toolUse = resp.response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.name !== "record_expenses") return null;

  const parsed = ParseExpenseOutputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    log("warn", "pipeline_parse_failed", { issues: parsed.error.issues });
    return null;
  }

  const items = parsed.data.expenses;
  const warnings: string[] = [];
  if (resp.warning) warnings.push(resp.warning);

  const out: ProcessedExpense[] = [];
  const embedFn = defaultEmbedFn();
  const fallback = buildClaudeFallback(args.sb, args.member.id);

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const inserted = await processSingleItem(
      args.sb,
      args.member,
      item,
      args.telegramMessageId,
      i,
      embedFn,
      fallback,
    );
    if (inserted) out.push(inserted);
  }

  return { expenses: out, warnings };
}

async function processSingleItem(
  sb: SupabaseClient,
  member: FamilyMember,
  item: ParsedExpenseRow,
  telegramMessageId: number,
  lineIndex: number,
  // deno-lint-ignore no-explicit-any
  embedFn: any,
  // deno-lint-ignore no-explicit-any
  fallback: any,
): Promise<ProcessedExpense | null> {
  const kind = item.kind ?? "expense";
  const db = tenantDb(sb, member.tenant_id);

  const cat = await categorize(
    { sb, embedFn, fallback },
    {
      name: item.name,
      nameNormalizedEn: item.name_normalized_en,
      familyMemberId: member.id,
      kind,
    },
  );

  const amountPln = await toPln(sb, item.amount, item.currency, item.expense_date)
    .catch((err) => {
      log("warn", "pipeline_currency_failed", { error: (err as Error).message });
      return item.currency === "PLN" ? item.amount : item.amount; // best-effort
    });

  // Ask for confirmation if EITHER the amount is high OR the categorizer
  // wasn't confident. Asking on every unsure item is the user's training loop:
  // each correction feeds the kNN for next time.
  const needsConfirmation = amountPln > HIGH_AMOUNT_PLN || cat.confidence !== "high";

  const ins = await db.from("expenses").insert({
    kind,
    name: item.name,
    name_normalized: item.name_normalized_en,
    expense_date: item.expense_date,
    amount: item.amount,
    currency: item.currency,
    amount_pln: amountPln,
    category_id: cat.categoryId,
    family_member_id: member.id,
    source: "text",
    description: item.description ?? null,
    needs_confirmation: needsConfirmation,
    confidence: cat.confidence === "high" ? 1.0 : cat.confidence === "medium" ? 0.85 : 0.5,
    embedding: cat.embedding,
    telegram_message_id: telegramMessageId,
    line_index: lineIndex,
  }).select("id").maybeSingle();

  if (ins.error || !ins.data) {
    log("warn", "pipeline_insert_failed", { error: ins.error?.message });
    return null;
  }

  // Fetch category name for the reply.
  const catRow = await db.from("categories").select("name").eq("id", cat.categoryId)
    .maybeSingle();
  const categoryName = (catRow.data as { name: string } | null)?.name ?? "?";

  return {
    id: (ins.data as { id: string }).id,
    kind,
    name: item.name,
    amount: item.amount,
    currency: item.currency,
    amount_pln: amountPln,
    expense_date: item.expense_date,
    category_name: categoryName,
    needs_confirmation: needsConfirmation,
    confidence: cat.confidence,
    high_amount: amountPln > HIGH_AMOUNT_PLN,
  };
}

export function formatReply(result: PipelineResult): string {
  if (result.expenses.length === 0) {
    return "Не понял, что записать. Попробуй: «кофе 12 zł».";
  }
  const lines = result.expenses.map((e) => {
    let tag = "";
    if (e.needs_confirmation) {
      if (e.high_amount && e.confidence !== "high") {
        tag = " (крупная сумма + не уверен в категории)";
      } else if (e.high_amount) {
        tag = " (крупная сумма)";
      } else {
        tag = " (категория не точно)";
      }
    }
    // ➕ green plus for income, plain "-" bullet for expense, so a glance at
    // the bubble tells you "money in" vs "money out" without reading.
    const bullet = e.kind === "income" ? "➕" : "-";
    const sign = e.kind === "income" ? "+" : "";
    return `${bullet} ${sign}${e.amount} ${e.currency} ${e.name} -> ${e.category_name}${tag}`;
  });

  // Header reflects whether the message was all income, all expense, or mixed.
  const hasIncome = result.expenses.some((e) => e.kind === "income");
  const hasExpense = result.expenses.some((e) => e.kind !== "income");
  const n = result.expenses.length;
  let head: string;
  if (hasIncome && !hasExpense) {
    head = n === 1 ? "💰 Доход:" : `💰 ${n} дохода:`;
  } else if (hasIncome && hasExpense) {
    head = `Записал ${n} (доход + расход):`;
  } else {
    head = n === 1 ? "Записал:" : `Записал ${n}:`;
  }

  // Show the total in the SOURCE currency when all items share one (so "3*400 лек"
  // sums to "1200 ALL", not "1200 PLN"). When the message mixes currencies, fall
  // back to the PLN normalization. For mixed kinds we split the total.
  const currencies = new Set(result.expenses.map((e) => e.currency));
  let totalLine = "";
  if (hasIncome && hasExpense) {
    const inSum = result.expenses
      .filter((e) => e.kind === "income")
      .reduce((acc, e) => acc + e.amount_pln, 0);
    const outSum = result.expenses
      .filter((e) => e.kind !== "income")
      .reduce((acc, e) => acc + e.amount_pln, 0);
    totalLine = `\nДоход: +${inSum.toFixed(2)} PLN\nРасход: -${outSum.toFixed(2)} PLN`;
  } else if (currencies.size === 1) {
    const cur = result.expenses[0]!.currency;
    const sourceTotal = result.expenses.reduce((acc, e) => acc + Number(e.amount), 0);
    const sign = hasIncome ? "+" : "";
    const label = hasIncome ? "Получил" : "Всего";
    totalLine = `\n${label}: ${sign}${sourceTotal.toFixed(2)} ${cur}`;
  } else {
    const totalPln = result.expenses.reduce((acc, e) => acc + e.amount_pln, 0);
    const sign = hasIncome ? "+" : "";
    const label = hasIncome ? "Получил" : "Всего";
    totalLine = `\n${label}: ${sign}${totalPln.toFixed(2)} PLN (смешанные валюты)`;
  }

  // Heads-up if any row was dated outside the current Warsaw month (the
  // dashboard's default "Месяц" filter would hide it).
  const today = todayWarsawIso();
  const currentMonth = today.slice(0, 7);
  const outOfMonth = [
    ...new Set(
      result.expenses
        .map((e) => e.expense_date.slice(0, 7))
        .filter((m) => m !== currentMonth),
    ),
  ];
  const dateHint = outOfMonth.length > 0
    ? `\n\n_Учтено за ${outOfMonth.join(", ")}. В дашборде переключи на «Период» чтобы увидеть._`
    : "";

  const warns = result.warnings.length ? "\n\nWarn: " + result.warnings.join("; ") : "";
  return [head, ...lines, totalLine].join("\n") + dateHint + warns;
}

/**
 * Build the inline keyboard markup for high-amount confirmation
 * (per SPEC §6.6). Returns null if none of the expenses need confirmation.
 */
export function highAmountKeyboard(result: PipelineResult): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} | null {
  const needs = result.expenses.find((e) => e.needs_confirmation);
  if (!needs) return null;
  return {
    inline_keyboard: [
      [
        { text: "Да", callback_data: `conf_yes:${needs.id}` },
        { text: "Изменить", callback_data: `conf_edit:${needs.id}` },
        { text: "Отмена", callback_data: `conf_no:${needs.id}` },
      ],
    ],
  };
}
