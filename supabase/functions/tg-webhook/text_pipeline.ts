// Full text/voice pipeline (SPEC §6.1):
//   Claude parse -> embed (gte-small) -> kNN categorize w/ Claude fallback ->
//   currency convert -> insert expenses -> reply with inline keyboard.
//
// Returns the structured outcome so the webhook handler can format the reply.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
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
  name: string;
  amount: number;
  currency: string;
  amount_pln: number;
  expense_date: string;
  category_name: string;
  needs_confirmation: boolean;
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
  const cat = await categorize(
    { sb, embedFn, fallback },
    {
      name: item.name,
      nameNormalizedEn: item.name_normalized_en,
      familyMemberId: member.id,
    },
  );

  const amountPln = await toPln(sb, item.amount, item.currency, item.expense_date)
    .catch((err) => {
      log("warn", "pipeline_currency_failed", { error: (err as Error).message });
      return item.currency === "PLN" ? item.amount : item.amount; // best-effort
    });

  const needsConfirmation = amountPln > HIGH_AMOUNT_PLN;

  const ins = await sb.from("expenses").insert({
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
    embedding: cat.embedding,
    telegram_message_id: telegramMessageId,
    line_index: lineIndex,
  }).select("id").maybeSingle();

  if (ins.error || !ins.data) {
    log("warn", "pipeline_insert_failed", { error: ins.error?.message });
    return null;
  }

  // Fetch category name for the reply.
  const catRow = await sb.from("categories").select("name").eq("id", cat.categoryId)
    .maybeSingle();
  const categoryName = (catRow.data as { name: string } | null)?.name ?? "?";

  return {
    id: (ins.data as { id: string }).id,
    name: item.name,
    amount: item.amount,
    currency: item.currency,
    amount_pln: amountPln,
    expense_date: item.expense_date,
    category_name: categoryName,
    needs_confirmation: needsConfirmation,
  };
}

export function formatReply(result: PipelineResult): string {
  if (result.expenses.length === 0) {
    return "Не понял, что записать. Попробуй: «кофе 12 zł».";
  }
  const lines = result.expenses.map((e) => {
    const conf = e.needs_confirmation ? " (подтвердить)" : "";
    return `- ${e.amount} ${e.currency} ${e.name} -> ${e.category_name}${conf}`;
  });
  const head = result.expenses.length === 1 ? "Записал:" : `Записал ${result.expenses.length}:`;
  const total = result.expenses.reduce((acc, e) => acc + e.amount_pln, 0);
  const totalLine = `\nВсего: ${total.toFixed(2)} PLN`;
  const warns = result.warnings.length ? "\n\nWarn: " + result.warnings.join("; ") : "";
  return [head, ...lines, totalLine].join("\n") + warns;
}
