// Full text/voice pipeline (SPEC §6.1):
//   Claude parse -> embed (gte-small) -> kNN categorize w/ Claude fallback ->
//   currency convert -> insert expenses -> reply with inline keyboard.
//
// Returns the structured outcome so the webhook handler can format the reply.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { callClaude } from "../_shared/claude.ts";
import { t } from "../_shared/i18n.ts";
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
  // How many parsed items were skipped as duplicates of an existing same-day
  // entry (same date + name + amount). Surfaced in the reply so the user can
  // see nothing was silently dropped when re-importing a list.
  skipped: number;
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

  // A bulk pasted list can hold 20+ items; each JSON row is ~60-90 output
  // tokens, so the 1024 cap would truncate the tool call mid-array. Scale up
  // for long messages while keeping single entries cheap.
  const maxTokens = args.text.length > 350 ? 4096 : 1024;

  let resp;
  try {
    resp = await callClaude({
      sb: args.sb,
      familyMemberId: args.member.id,
      tenantId: args.member.tenant_id,
      model,
      system,
      tools,
      maxTokens,
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
  let skipped = 0;
  const embedFn = defaultEmbedFn();
  const fallback = buildClaudeFallback(args.sb, args.member.id, args.member.tenant_id);

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
    if (inserted === "duplicate") skipped++;
    else if (inserted) out.push(inserted);
  }

  return { expenses: out, warnings, skipped };
}

// True when an identical entry (same member, date, name, amount) already exists,
// so re-pasting a list doesn't double-record. Names are compared
// case-insensitively. Deliberately conservative: only an exact amount + date +
// name match counts as a duplicate.
async function isDuplicate(
  db: ReturnType<typeof tenantDb>,
  member: FamilyMember,
  item: ParsedExpenseRow,
): Promise<boolean> {
  const dup = await db.from("expenses")
    .select("id")
    .eq("family_member_id", member.id)
    .eq("expense_date", item.expense_date)
    .eq("amount", item.amount)
    .ilike("name", item.name)
    .limit(1)
    .maybeSingle();
  return !!dup.data;
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
): Promise<ProcessedExpense | "duplicate" | null> {
  const kind = item.kind ?? "expense";
  const db = tenantDb(sb, member.tenant_id);

  // Skip an item that already exists for this day (same name + amount). Lets a
  // user safely re-paste a partly-recorded list without creating doubles.
  if (await isDuplicate(db, member, item)) return "duplicate";

  const cat = await categorize(
    { sb, embedFn, fallback },
    {
      name: item.name,
      nameNormalizedEn: item.name_normalized_en,
      tenantId: member.tenant_id,
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

export function formatReply(result: PipelineResult, locale = "ru"): string {
  if (result.expenses.length === 0) {
    // Everything in the list was already recorded for those days.
    if (result.skipped > 0) return t(locale, "dup_all", { n: String(result.skipped) });
    return t(locale, "not_understood");
  }
  const lines = result.expenses.map((e) => {
    let tag = "";
    if (e.needs_confirmation) {
      if (e.high_amount && e.confidence !== "high") {
        tag = t(locale, "tag_high_uncat");
      } else if (e.high_amount) {
        tag = t(locale, "tag_high");
      } else {
        tag = t(locale, "tag_uncat");
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
    head = n === 1 ? t(locale, "rec_income_1") : t(locale, "rec_income_n", { n: String(n) });
  } else if (hasIncome && hasExpense) {
    head = t(locale, "rec_mixed", { n: String(n) });
  } else {
    head = n === 1 ? t(locale, "rec_saved") : t(locale, "rec_saved_n", { n: String(n) });
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
    totalLine = `\n${t(locale, "lbl_income")}: +${inSum.toFixed(2)} PLN\n${
      t(locale, "lbl_expense")
    }: -${outSum.toFixed(2)} PLN`;
  } else if (currencies.size === 1) {
    const cur = result.expenses[0]!.currency;
    const sourceTotal = result.expenses.reduce((acc, e) => acc + Number(e.amount), 0);
    const sign = hasIncome ? "+" : "";
    const label = hasIncome ? t(locale, "total_got") : t(locale, "total_all");
    totalLine = `\n${label}: ${sign}${sourceTotal.toFixed(2)} ${cur}`;
  } else {
    const totalPln = result.expenses.reduce((acc, e) => acc + e.amount_pln, 0);
    const sign = hasIncome ? "+" : "";
    const label = hasIncome ? t(locale, "total_got") : t(locale, "total_all");
    totalLine = `\n${label}: ${sign}${totalPln.toFixed(2)} PLN${t(locale, "mixed_ccy")}`;
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
    ? t(locale, "date_hint", { months: outOfMonth.join(", ") })
    : "";

  // Note how many list items were skipped as already-recorded duplicates.
  const dupNote = result.skipped > 0
    ? "\n" + t(locale, "dup_some", { n: String(result.skipped) })
    : "";

  const warns = result.warnings.length ? "\n\nWarn: " + result.warnings.join("; ") : "";
  return [head, ...lines, totalLine].join("\n") + dateHint + dupNote + warns;
}

/**
 * Build the inline keyboard markup for high-amount confirmation
 * (per SPEC §6.6). Returns null if none of the expenses need confirmation.
 */
export function highAmountKeyboard(result: PipelineResult, locale = "ru"): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} | null {
  const needs = result.expenses.find((e) => e.needs_confirmation);
  if (!needs) return null;
  return {
    inline_keyboard: [
      [
        { text: t(locale, "btn_yes"), callback_data: `conf_yes:${needs.id}` },
        { text: t(locale, "btn_edit"), callback_data: `conf_edit:${needs.id}` },
        { text: t(locale, "btn_cancel"), callback_data: `conf_no:${needs.id}` },
      ],
    ],
  };
}
