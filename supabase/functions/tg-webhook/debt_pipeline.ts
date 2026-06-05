// Text → debt: parse a free-form Russian/English/Polish message that
// announces a loan ('1000 дал в долг Паше', 'взял у Маши 500') into a
// debts row. Intent classifier routes here via 'debt' intent.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember } from "../_shared/types.ts";
import { callClaude } from "../_shared/claude.ts";
import {
  buildDebtSystemPrompt,
  ParseDebtOutputSchema,
  ParseDebtTool,
} from "../_shared/prompts/parse_debt.ts";
import { todayWarsawIso } from "../_shared/dates.ts";
import { log } from "../_shared/log.ts";

export type DebtPipelineOutcome =
  | { kind: "parse_failed"; reason: string }
  | {
    kind: "ok";
    debt_id: string;
    direction: "owed_to_me" | "i_owe";
    counterparty: string;
    amount: number;
    currency: string;
    borrowed_at: string;
    due_date: string | null;
  };

export async function processDebtMessage(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  text: string;
}): Promise<DebtPipelineOutcome> {
  const today = todayWarsawIso();
  const system = buildDebtSystemPrompt(today);
  const model = Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-4-5-20251001";

  let resp;
  try {
    resp = await callClaude({
      sb: args.sb,
      familyMemberId: args.member.id,
      model,
      system,
      tools: [ParseDebtTool],
      maxTokens: 512,
      toolChoice: { type: "tool", name: "record_debt" },
      messages: [{ role: "user", content: [{ type: "text", text: args.text }] }],
    });
  } catch (err) {
    log("error", "debt_parse_claude_failed", { error: (err as Error).message });
    return { kind: "parse_failed", reason: (err as Error).message };
  }

  const toolUse = resp.response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.name !== "record_debt") {
    return { kind: "parse_failed", reason: "no_tool_use_block" };
  }
  const parsed = ParseDebtOutputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    log("warn", "debt_parse_bad_schema", { issues: parsed.error.issues });
    return { kind: "parse_failed", reason: "schema_invalid" };
  }
  const d = parsed.data;
  const borrowedAt = d.borrowed_at ?? today;

  const ins = await args.sb.from("debts").insert({
    family_member_id: args.member.id,
    direction: d.direction,
    counterparty: d.counterparty,
    amount: d.amount,
    currency: d.currency,
    remaining_balance: d.amount,
    borrowed_at: borrowedAt,
    due_date: d.due_date ?? null,
    notify_3d_before: true,
    notify_on_due: true,
    notify_overdue: true,
    notes: d.note ?? null,
  }).select("id").maybeSingle();
  if (ins.error || !ins.data) {
    return { kind: "parse_failed", reason: ins.error?.message ?? "insert_failed" };
  }
  const debtId = (ins.data as { id: string }).id;
  log("info", "debt_created_from_text", {
    debt_id: debtId,
    direction: d.direction,
    amount: d.amount,
    currency: d.currency,
  });
  return {
    kind: "ok",
    debt_id: debtId,
    direction: d.direction,
    counterparty: d.counterparty,
    amount: d.amount,
    currency: d.currency,
    borrowed_at: borrowedAt,
    due_date: d.due_date ?? null,
  };
}

export function formatDebtReply(o: DebtPipelineOutcome): string {
  if (o.kind === "parse_failed") {
    return `Не смог распознать долг (${o.reason}). Попробуй явнее: «дал в долг Паше 1000 PLN до 15 июля».`;
  }
  const verb = o.direction === "owed_to_me" ? "Должен мне" : "Я должен";
  const sumStr = Number(o.amount).toFixed(2).replace(/\.00$/, "") + " " + o.currency;
  const dueLine = o.due_date ? `\nСрок: ${o.due_date}` : "";
  return `✅ ${verb}: ${o.counterparty} - ${sumStr}\nДата: ${o.borrowed_at}${dueLine}`;
}
