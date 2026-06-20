// Tool-using analyst agent for /ask.
//
// SAFETY MODEL:
// - Read tools are executed server-side, results sent back to the model.
//   The model can call them as often as it wants, capped by MAX_TOOL_CALLS.
// - The "propose_changes" tool DOES NOT execute anything. It records the
//   intended actions in the database (table ask_proposals) and returns a
//   proposal_id. Actions are applied only after the user taps "Применить"
//   in Telegram, which fires askapply:<proposal_id> through the regular
//   callback flow. So nothing can change without explicit human consent.
// - All actions are typed via Zod; no raw SQL ever reaches Claude.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type { FamilyMember } from "./types.ts";
import { tenantDb } from "./tenant_db.ts";
import { callClaude } from "./claude.ts";
import { buildAnalystSnapshot } from "./analyst_snapshot.ts";
import { type Locale, LOCALE_ENGLISH_NAME } from "./i18n.ts";
import { log } from "./log.ts";

const MAX_TOOL_CALLS = 8; // hard cap per /ask to bound latency + cost
const PROPOSAL_TTL_MIN = 10;

// ---- Tool input schemas ---------------------------------------------------

interface QueryExpensesInput {
  from?: string; // YYYY-MM-DD
  to?: string;
  category_id?: string;
  family_member_id?: string;
  source?: "text" | "voice" | "photo";
  name_contains?: string;
  kind?: "expense" | "income"; // defaults to expense for backwards compat
  limit?: number; // capped at 100
}

interface QueryReceiptsInput {
  from?: string;
  to?: string;
  merchant_contains?: string;
  limit?: number;
}

type ProposedAction =
  | { kind: "delete_expense"; expense_id: string; summary?: string }
  | {
    kind: "recategorize_expense";
    expense_id: string;
    new_category_id: string;
    summary?: string;
  }
  | { kind: "delete_receipt"; receipt_id: string; summary?: string }
  | {
    kind: "mark_reconciled";
    expense_id: string;
    /** card / cash / transfer - what the bank statement says it was. */
    payment_method: "card" | "cash" | "transfer";
    /** Optional: the real PLN amount from the bank (e.g. 18.45 instead of our NBP-estimated 17.16). */
    amount_pln_override?: number;
    summary?: string;
  };

interface ProposeChangesInput {
  human_summary: string;
  actions: ProposedAction[];
}

// ---- Tool implementations -------------------------------------------------

async function tQueryExpenses(
  sb: SupabaseClient,
  tenantId: string,
  input: QueryExpensesInput,
): Promise<unknown> {
  const db = tenantDb(sb, tenantId);
  const limit = Math.min(Math.max(Number(input.limit ?? 30), 1), 100);
  // Default to expense for backwards compat. Pass kind='income' to get
  // income rows. Pass kind='any' (handled as no filter) only if explicitly
  // intended; we don't expose 'any' through the tool schema for now.
  const kind = input.kind === "income" ? "income" : "expense";
  let q = db.from("expenses")
    .select(
      "id, kind, name, amount, currency, amount_pln, category_id, family_member_id, source, expense_date, receipt_id, needs_confirmation, archived",
    )
    .eq("archived", false)
    .eq("kind", kind)
    .order("expense_date", { ascending: false })
    .limit(limit);
  if (input.from) q = q.gte("expense_date", input.from);
  if (input.to) q = q.lte("expense_date", input.to);
  if (input.category_id && /^[0-9a-f-]{36}$/i.test(input.category_id)) {
    q = q.eq("category_id", input.category_id);
  }
  if (input.family_member_id && /^[0-9a-f-]{36}$/i.test(input.family_member_id)) {
    q = q.eq("family_member_id", input.family_member_id);
  }
  if (input.source) q = q.eq("source", input.source);
  if (input.name_contains) q = q.ilike("name", `%${input.name_contains}%`);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { rows: data ?? [], count: (data ?? []).length };
}

async function tQueryReceipts(
  sb: SupabaseClient,
  tenantId: string,
  input: QueryReceiptsInput,
): Promise<unknown> {
  const db = tenantDb(sb, tenantId);
  const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50);
  let q = db.from("receipts")
    .select("id, merchant, total, currency, receipt_date, family_member_id")
    .eq("archived", false)
    .order("receipt_date", { ascending: false })
    .limit(limit);
  if (input.from) q = q.gte("receipt_date", input.from);
  if (input.to) q = q.lte("receipt_date", input.to);
  if (input.merchant_contains) q = q.ilike("merchant", `%${input.merchant_contains}%`);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { rows: data ?? [], count: (data ?? []).length };
}

async function tListCategories(sb: SupabaseClient, tenantId: string): Promise<unknown> {
  const db = tenantDb(sb, tenantId);
  const { data, error } = await db.from("categories")
    .select("id, name, kind, is_fallback")
    .order("kind", { ascending: true })
    .order("is_fallback", { ascending: true })
    .order("name", { ascending: true });
  if (error) return { error: error.message };
  return { rows: data ?? [] };
}

async function tListRecurring(sb: SupabaseClient, tenantId: string): Promise<unknown> {
  const db = tenantDb(sb, tenantId);
  const { data, error } = await db.from("recurring_expenses")
    .select("id, name, amount, currency, day_of_month, active, category_id, family_member_id");
  if (error) return { error: error.message };
  return { rows: data ?? [] };
}

function validateActions(raw: unknown): ProposedAction[] {
  if (!Array.isArray(raw)) return [];
  const UUID = /^[0-9a-f-]{36}$/i;
  const out: ProposedAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const obj = a as Record<string, unknown>;
    if (
      obj.kind === "delete_expense" && typeof obj.expense_id === "string" &&
      UUID.test(obj.expense_id)
    ) {
      out.push({
        kind: "delete_expense",
        expense_id: obj.expense_id,
        summary: typeof obj.summary === "string" ? obj.summary : undefined,
      });
    } else if (
      obj.kind === "recategorize_expense" &&
      typeof obj.expense_id === "string" && UUID.test(obj.expense_id) &&
      typeof obj.new_category_id === "string" && UUID.test(obj.new_category_id)
    ) {
      out.push({
        kind: "recategorize_expense",
        expense_id: obj.expense_id,
        new_category_id: obj.new_category_id,
        summary: typeof obj.summary === "string" ? obj.summary : undefined,
      });
    } else if (
      obj.kind === "delete_receipt" &&
      typeof obj.receipt_id === "string" && UUID.test(obj.receipt_id)
    ) {
      out.push({
        kind: "delete_receipt",
        receipt_id: obj.receipt_id,
        summary: typeof obj.summary === "string" ? obj.summary : undefined,
      });
    } else if (
      obj.kind === "mark_reconciled" &&
      typeof obj.expense_id === "string" && UUID.test(obj.expense_id) &&
      (obj.payment_method === "card" || obj.payment_method === "cash" ||
        obj.payment_method === "transfer")
    ) {
      const override = typeof obj.amount_pln_override === "number" &&
          obj.amount_pln_override > 0
        ? obj.amount_pln_override
        : undefined;
      out.push({
        kind: "mark_reconciled",
        expense_id: obj.expense_id,
        payment_method: obj.payment_method,
        amount_pln_override: override,
        summary: typeof obj.summary === "string" ? obj.summary : undefined,
      });
    }
  }
  return out;
}

// ---- Tool schemas (sent to Claude) ----------------------------------------

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "query_expenses",
    description:
      "Get a filtered list of expenses (or incomes). Use this to find specific transactions the user is asking about (e.g. 'все траты на воду в мае'). Returns up to `limit` rows ordered by date desc. DEFAULT kind='expense'. Pass kind='income' to query income rows instead (e.g. 'сколько я заработал в мае?').",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["expense", "income"],
          description:
            "expense (default) or income. Use 'income' to answer questions about earnings, salary, dividends, gifts received.",
        },
        from: {
          type: "string",
          description: "Start date inclusive, ISO YYYY-MM-DD",
        },
        to: { type: "string", description: "End date inclusive, ISO YYYY-MM-DD" },
        category_id: { type: "string", description: "UUID of a category" },
        family_member_id: { type: "string", description: "UUID of a family member" },
        source: { type: "string", enum: ["text", "voice", "photo"] },
        name_contains: {
          type: "string",
          description: "Case-insensitive substring match on expense name",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "query_receipts",
    description: "Get a filtered list of photo receipts.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        merchant_contains: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "list_categories",
    description: "Get all categories (id, name, is_fallback).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_recurring",
    description: "Get all recurring expenses (subscriptions, rent, etc.).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_changes",
    description:
      "Propose a set of write actions to apply to the user's data. THIS DOES NOT EXECUTE THE CHANGES - the user must confirm them by tapping a button. Use this tool ONLY when the user explicitly asks to delete, archive, or recategorize something. Always include a clear human_summary so the user knows what they're confirming. Never propose changes the user didn't ask for.",
    input_schema: {
      type: "object",
      required: ["human_summary", "actions"],
      properties: {
        human_summary: {
          type: "string",
          description:
            "One paragraph in Russian explaining what the user is about to confirm. Be concrete: include item names, amounts, currencies, dates, and target categories. The user reads this and either taps Применить or Отмена.",
        },
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: {
                type: "string",
                enum: [
                  "delete_expense",
                  "recategorize_expense",
                  "delete_receipt",
                  "mark_reconciled",
                ],
              },
              expense_id: { type: "string", description: "UUID, required for expense actions" },
              receipt_id: { type: "string", description: "UUID, required for delete_receipt" },
              new_category_id: {
                type: "string",
                description: "UUID, required for recategorize_expense",
              },
              payment_method: {
                type: "string",
                enum: ["card", "cash", "transfer"],
                description:
                  "REQUIRED for mark_reconciled. The bank-confirmed method: card, cash, or transfer (BLIK/SEPA).",
              },
              amount_pln_override: {
                type: "number",
                description:
                  "Optional, for mark_reconciled. The exact PLN amount the bank charged - use this when the user explicitly states a bank-PLN value (e.g. 'в выписке 18.45 PLN' means the row's amount_pln should be updated to 18.45, replacing the NBP estimate).",
              },
              summary: {
                type: "string",
                description: "Short per-row description for the audit log",
              },
            },
          },
        },
      },
    },
  },
];

// ---- Main entry -----------------------------------------------------------

export interface AskAgentResult {
  text: string;
  proposalId: string | null;
  actionCount: number;
}

export interface AskTurn {
  question: string;
  answer: string;
}

const SYSTEM_RULES =
  `Ты - личный финансовый аналитик-агент семьи в боте FinBot. У тебя есть инструменты для чтения данных и для предложения изменений.

ПРАВИЛА БЕЗОПАСНОСТИ:
1. Изменения в данных делает ТОЛЬКО пользователь через кнопки подтверждения, не ты. Твоя задача: понять что он хочет, найти нужные записи через query_expenses/query_receipts/list_categories, и вызвать propose_changes с конкретным планом.
2. НИКОГДА не предлагай изменения, о которых пользователь явно не просил. Если он спросил "сколько я потратил" - НЕ надо ничего удалять. Если попросил "удали воду за май" - удали ИМЕННО эти траты, не трогай остальное.
3. Если непонятно к чему относится запрос - ЗАДАЙ уточняющий вопрос вместо того чтобы догадываться.
4. Если действие может затронуть много записей (например 10+) - сначала покажи ИХ СПИСОК в human_summary и попроси подтверждения.

ПРАВИЛА ДАННЫХ:
- query_expenses возвращает только archived=false (актуальные). По умолчанию возвращает РАСХОДЫ (kind='expense'). Чтобы получить доходы, передай source=null и используй kind='income' (см. параметры).
- expense_id и category_id и receipt_id - это UUID из базы. Бери их ТОЛЬКО из реальных query-результатов или из snapshot, не выдумывай.
- В snapshot поле totals.* и current_month.* - это РАСХОДЫ. Доход живёт отдельно в income.month_to_date / income.previous_month / income.current_month. Нетто = доход - расход и уже посчитан в income.month_to_date.net_eur (может быть отрицательным).
- propose_changes принимает массив actions. Каждое action описывает одну запись, которую затронет. Поддерживаемые kinds:
  - delete_expense - архивирует одну трату ИЛИ доход (по expense_id) - механика та же, table одна
  - recategorize_expense - меняет категорию (expense_id + new_category_id). ВАЖНО: новая категория должна быть того же kind (доходная-у-доходной, расходная-у-расходной)
  - delete_receipt - архивирует чек + все его строки (receipt_id)
  - mark_reconciled - помечает запись как сверённую с банком: payment_method=card/cash/transfer, reconciled_at=now, опционально amount_pln_override (точная PLN-сумма из выписки). Используй когда юзер говорит "куплено картой / наличными", "в выписке X PLN", "сверь с банком", "отметь", "это позиция X в выписке".

ПРИМЕРЫ mark_reconciled:
- "Отметь овощи 18.45 PLN как карту" → найди "овощи" через query_expenses, propose mark_reconciled с payment_method='card' и amount_pln_override=18.45.
- "Парковка наличными" → найди "Парковка", propose mark_reconciled с payment_method='cash' (без amount_pln_override - сумма в БД уже верная).
- "В выписке 38 PLN это SPAR за вчера, картой" → найди SPAR-чек или solo "SPAR" расход на ту дату, propose mark_reconciled с payment_method='card', amount_pln_override=38.
- Если строка не одна (несколько кандидатов под сумму) - сначала уточни через query_expenses, потом предложи 1-2 варианта.

ФОРМАТИРОВАНИЕ ОТВЕТА:
- Plain text, никакого Markdown (без двойных звёздочек, одинарных звёздочек, подчёркиваний, обратных кавычек, решёток).
- Русский язык, дружелюбный, конкретный тон.
- Если ты вызвал propose_changes - твой финальный текст должен суммаризировать что будет сделано. Не повторяй сам список, его покажет бот.
- Если изменений не нужно - просто ответь на вопрос пользователя по данным.`;

export async function runAskAgent(args: {
  sb: SupabaseClient;
  viewer: FamilyMember;
  question: string;
  priorTurns?: AskTurn[];
}): Promise<AskAgentResult> {
  const { sb, viewer, question, priorTurns } = args;
  const db = tenantDb(sb, viewer.tenant_id);
  const snapshot = await buildAnalystSnapshot(sb, viewer.tenant_id);

  // Render prior turns as a "Предыдущая беседа" preamble so a follow-up
  // question (e.g. "Как считал?") has the earlier Q/A in context. We pass
  // them as plain text rather than reconstructing the full tool-call history -
  // the model doesn't need to see prior tool_use blocks, just what was asked
  // and what was answered.
  const priorBlock = (priorTurns && priorTurns.length > 0)
    ? "Предыдущая беседа (для контекста, не повторяй):\n" +
      priorTurns.map((t, i) => `[Тур ${i + 1}]\nВопрос: ${t.question}\nОтвет: ${t.answer}`).join(
        "\n\n",
      ) + "\n\n"
    : "";

  // Conversation state. We carry the assistant turns + tool results back
  // into the model on every loop iteration.
  const messages: Anthropic.Messages.MessageParam[] = [{
    role: "user",
    content: [
      {
        type: "text",
        text:
          `ВАЖНО: отвечай пользователю на языке "${
            LOCALE_ENGLISH_NAME[(viewer.locale ?? "ru") as Locale] ?? "Russian"
          }".\n` +
          `Контекст: viewer_id=${viewer.id}, viewer_name=${viewer.name}, viewer_role=${viewer.role}.\n` +
          `Финансовый snapshot (только для общих вопросов; для точечных действий используй tool query_expenses):\n` +
          "```json\n" + JSON.stringify(snapshot) + "\n```\n\n" +
          priorBlock +
          `Новый вопрос пользователя: ${question}`,
      },
    ],
  }];

  let proposalActions: ProposedAction[] | null = null;
  let proposalSummary = "";
  let finalText = "";

  for (let iter = 0; iter < MAX_TOOL_CALLS; iter++) {
    const { response } = await callClaude({
      sb,
      familyMemberId: viewer.id,
      tenantId: viewer.tenant_id,
      model: Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-4-5-20251001",
      system: [{
        type: "text",
        text: SYSTEM_RULES,
        cache_control: { type: "ephemeral" },
      }],
      tools: TOOLS,
      maxTokens: 1500,
      messages,
    });

    // Save the assistant turn verbatim (model may have tool_use blocks).
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((c) => c.type === "tool_use") as Array<
      Anthropic.Messages.ToolUseBlock
    >;
    const textBlocks = response.content
      .filter((c) => c.type === "text")
      .map((c) => (c as Anthropic.Messages.TextBlock).text);

    if (toolUses.length === 0) {
      // Final answer (no more tool calls).
      finalText = textBlocks.join("\n").trim();
      break;
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let result: unknown;
      try {
        if (tu.name === "query_expenses") {
          result = await tQueryExpenses(sb, viewer.tenant_id, tu.input as QueryExpensesInput);
        } else if (tu.name === "query_receipts") {
          result = await tQueryReceipts(sb, viewer.tenant_id, tu.input as QueryReceiptsInput);
        } else if (tu.name === "list_categories") {
          result = await tListCategories(sb, viewer.tenant_id);
        } else if (tu.name === "list_recurring") {
          result = await tListRecurring(sb, viewer.tenant_id);
        } else if (tu.name === "propose_changes") {
          const input = tu.input as ProposeChangesInput;
          const validated = validateActions(input.actions);
          proposalActions = validated;
          proposalSummary = String(input.human_summary ?? "");
          result = {
            ok: true,
            queued: validated.length,
            note: "Proposal queued. The user will see a confirmation with Apply/Cancel buttons.",
          };
          // Take the model's text-blocks if any AS the final answer; we
          // expect a short closing sentence, but the bot's reply text will
          // be human_summary regardless.
          finalText = textBlocks.join("\n").trim() || proposalSummary;
        } else {
          result = { error: `unknown tool: ${tu.name}` };
        }
      } catch (err) {
        result = { error: (err as Error).message };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });

    // If the proposal was queued in this turn we're done - no need to keep
    // looping. We already captured finalText.
    if (proposalActions) break;
  }

  if (!finalText) {
    finalText =
      "Не смог сформулировать ответ. Попробуй переформулировать вопрос или уточнить детали.";
  }

  // Persist proposal if any.
  let proposalId: string | null = null;
  if (proposalActions && proposalActions.length > 0) {
    const ins = await db.from("ask_proposals").insert({
      proposer_family_member_id: viewer.id,
      proposer_telegram_id: viewer.telegram_id,
      question,
      actions: proposalActions,
      expires_at: new Date(Date.now() + PROPOSAL_TTL_MIN * 60_000).toISOString(),
    }).select("id").maybeSingle();
    if (ins.error || !ins.data) {
      log("error", "ask_proposal_insert_failed", { error: ins.error?.message });
    } else {
      proposalId = (ins.data as { id: string }).id;
    }
  }

  return {
    text: finalText,
    proposalId,
    actionCount: proposalActions?.length ?? 0,
  };
}

export { type ProposedAction };
