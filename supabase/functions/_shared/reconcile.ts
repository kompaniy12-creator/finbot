// Bank-statement reconciliation: match a pending bank line to either a
// photographed receipt or a solo expense in our DB.
//
// Empirically (mBank, June 2026, see bank_statement_lines + matched
// receipts): mBank converts ALL→PLN at roughly 1.0753-1.0779x the NBP daily
// rate. We use that as the constant FX markup. If a different bank shows up
// later with a different markup, this constant should be replaced with a
// per-bank lookup.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysIso } from "./dates.ts";
import { tenantDb } from "./tenant_db.ts";

const BANK_FX_MARKUP_ALL_TO_PLN = 1.0765; // midpoint of 1.0753-1.0779
const FX_TOLERANCE_PCT = 0.02; // ±2% for cross-currency matches
const SAME_CCY_TOLERANCE_PCT = 0.005; // ±0.5% for same-currency
const DATE_WINDOW_DAYS = 5; // card transactions can post 1-5 days after swipe

export type BankLineKind = "expense" | "income";
export type PaymentMethod = "card" | "cash" | "transfer" | "fee";

export interface BankLine {
  id: string;
  family_member_id: string;
  posted_date: string; // YYYY-MM-DD
  amount: number; // always positive
  currency: "PLN" | "EUR" | "ALL" | "USD";
  description: string;
  method: PaymentMethod;
  kind: BankLineKind;
  status: "pending" | "matched" | "added" | "skipped";
}

export type ReconcileOutcome =
  | { line_id: string; status: "matched"; matched_kind: "receipt" | "expense"; matched_id: string }
  | { line_id: string; status: "ambiguous"; candidate_count: number }
  | { line_id: string; status: "no_candidate" }
  | { line_id: string; status: "skipped"; reason: string };

interface ReceiptRow {
  id: string;
  total: number;
  currency: string;
  total_pln: number;
  receipt_date: string;
  merchant: string | null;
}

interface ExpenseRow {
  id: string;
  amount: number;
  currency: string;
  amount_pln: number;
  expense_date: string;
  kind: "expense" | "income" | null;
  name: string;
  reconciled_at: string | null;
}

interface MatchCandidate {
  type: "receipt" | "expense";
  id: string;
  /** Predicted PLN amount the bank would charge for this row. */
  predicted_bank_pln: number;
  /** Underlying NBP-rate PLN amount (what we stored). */
  our_pln: number;
  /** |predicted - actual| / actual. Lower = better match. */
  score: number;
}

function toleranceFor(ourCcy: string, bankCcy: string): number {
  return ourCcy === bankCcy ? SAME_CCY_TOLERANCE_PCT : FX_TOLERANCE_PCT;
}

/** Predict what the bank would charge for an ALL receipt of `ourPln` zlotys at NBP. */
function predictBankPln(ourPln: number, ourCcy: string, bankCcy: string): number | null {
  if (ourCcy === bankCcy) return Number(ourPln);
  if (ourCcy === "ALL" && bankCcy === "PLN") return Number(ourPln) * BANK_FX_MARKUP_ALL_TO_PLN;
  // EUR/USD purchases on a PLN card: card networks convert EUR/USD→PLN
  // through their own rate which is usually within ±1% of NBP, but mBank
  // adds ~1-2% spread. Use a smaller markup until we have empirical data.
  if ((ourCcy === "EUR" || ourCcy === "USD") && bankCcy === "PLN") {
    return Number(ourPln) * 1.02;
  }
  return null;
}

/**
 * Try to find the unique receipt or solo expense in the DB that matches
 * a single bank statement line. Returns matched/ambiguous/no_candidate.
 *
 * Does NOT mutate the DB - apply() does that. Splitting keeps the
 * algorithm pure and testable, and lets the caller batch-update with a
 * single round-trip if desired.
 */
export async function findCandidates(
  sb: SupabaseClient,
  tenantId: string,
  line: BankLine,
): Promise<MatchCandidate[]> {
  const db = tenantDb(sb, tenantId);
  if (line.status !== "pending") return [];

  const fromDate = addDaysIso(line.posted_date, -DATE_WINDOW_DAYS);
  const toDate = addDaysIso(line.posted_date, 1);
  const bankPln = Number(line.amount);

  // ---- Receipt-level candidates (sum of children) ----
  const receiptsRes = await db.from("receipts")
    .select("id, total, currency, total_pln, receipt_date, merchant")
    .eq("family_member_id", line.family_member_id)
    .eq("archived", false)
    .gte("receipt_date", fromDate)
    .lte("receipt_date", toDate);
  const receipts = (receiptsRes.data ?? []) as ReceiptRow[];
  // Drop receipts that are already reconciled (any child has reconciled_at).
  const receiptIds = receipts.map((r) => r.id);
  let availableReceipts = receipts;
  if (receiptIds.length > 0) {
    const childRes = await db.from("expenses")
      .select("receipt_id, reconciled_at")
      .in("receipt_id", receiptIds);
    const reconciledSet = new Set(
      ((childRes.data ?? []) as Array<{ receipt_id: string; reconciled_at: string | null }>)
        .filter((c) => c.reconciled_at !== null)
        .map((c) => c.receipt_id),
    );
    availableReceipts = receipts.filter((r) => !reconciledSet.has(r.id));
  }

  const candidates: MatchCandidate[] = [];
  for (const r of availableReceipts) {
    const predicted = predictBankPln(Number(r.total_pln), r.currency, line.currency);
    if (predicted === null) continue;
    const diffPct = Math.abs(predicted - bankPln) / bankPln;
    if (diffPct <= toleranceFor(r.currency, line.currency)) {
      candidates.push({
        type: "receipt",
        id: r.id,
        predicted_bank_pln: predicted,
        our_pln: Number(r.total_pln),
        score: diffPct,
      });
    }
  }

  // ---- Solo-expense candidates (no receipt_id) ----
  const soloRes = await db.from("expenses")
    .select("id, amount, currency, amount_pln, expense_date, kind, name, reconciled_at")
    .eq("family_member_id", line.family_member_id)
    .eq("archived", false)
    .is("receipt_id", null)
    .is("reconciled_at", null)
    .eq("kind", line.kind)
    .gte("expense_date", fromDate)
    .lte("expense_date", toDate);
  const solos = (soloRes.data ?? []) as ExpenseRow[];
  for (const e of solos) {
    const predicted = predictBankPln(Number(e.amount_pln), e.currency, line.currency);
    if (predicted === null) continue;
    const diffPct = Math.abs(predicted - bankPln) / bankPln;
    if (diffPct <= toleranceFor(e.currency, line.currency)) {
      candidates.push({
        type: "expense",
        id: e.id,
        predicted_bank_pln: predicted,
        our_pln: Number(e.amount_pln),
        score: diffPct,
      });
    }
  }

  return candidates;
}

/**
 * Apply a match: stamp reconciled_at/payment_method/bank_statement_line_id
 * on the expense rows and scale amount_pln to the bank's real PLN value.
 * Updates bank_statement_lines.status='matched'.
 *
 * For receipt matches: scales every child expense's amount_pln
 * proportionally so sum(children) == bank_pln. This keeps EUR/dashboard
 * totals accurate.
 */
export async function applyMatch(
  sb: SupabaseClient,
  tenantId: string,
  line: BankLine,
  candidate: MatchCandidate,
): Promise<ReconcileOutcome> {
  const db = tenantDb(sb, tenantId);
  const nowIso = new Date().toISOString();
  const bankPln = Number(line.amount);

  if (candidate.type === "expense") {
    const upd = await db.from("expenses").update({
      amount_pln: bankPln,
      reconciled_at: nowIso,
      payment_method: line.method,
      bank_statement_line_id: line.id,
    }).eq("id", candidate.id);
    if (upd.error) {
      return { line_id: line.id, status: "skipped", reason: upd.error.message };
    }
    await db.from("bank_statement_lines").update({
      status: "matched",
      matched_expense_id: candidate.id,
    }).eq("id", line.id);
    return {
      line_id: line.id,
      status: "matched",
      matched_kind: "expense",
      matched_id: candidate.id,
    };
  }

  // Receipt: scale + reconcile children, update receipt total.
  const ratio = bankPln / candidate.our_pln;
  // Fetch children to scale amount_pln per-row.
  const childRes = await db.from("expenses")
    .select("id, amount_pln")
    .eq("receipt_id", candidate.id)
    .eq("archived", false);
  const children = (childRes.data ?? []) as Array<{ id: string; amount_pln: number }>;
  // Distribute the bank PLN total across children proportionally (last child
  // absorbs the rounding remainder so sum exactly equals bankPln).
  let runningSum = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    const newPln = i === children.length - 1
      ? Math.round((bankPln - runningSum) * 100) / 100
      : Math.round(Number(c.amount_pln) * ratio * 100) / 100;
    runningSum += newPln;
    await db.from("expenses").update({
      amount_pln: newPln,
      reconciled_at: nowIso,
      payment_method: line.method,
      bank_statement_line_id: line.id,
    }).eq("id", c.id);
  }
  await db.from("receipts").update({ total_pln: bankPln }).eq("id", candidate.id);
  await db.from("bank_statement_lines").update({ status: "matched" }).eq("id", line.id);
  return {
    line_id: line.id,
    status: "matched",
    matched_kind: "receipt",
    matched_id: candidate.id,
  };
}

/**
 * Top-level: try to reconcile a single pending line. Picks the best
 * (lowest-score) candidate if exactly one is unambiguously best; otherwise
 * leaves the line pending for user triage.
 */
export async function reconcileLine(
  sb: SupabaseClient,
  tenantId: string,
  line: BankLine,
): Promise<ReconcileOutcome> {
  // Skip transfers between own accounts and bank fees we don't want auto-
  // attached to any user-recorded receipt. The orchestrator can decide
  // separately whether to mark these as 'skipped' in DB.
  const desc = (line.description || "").toLowerCase();
  if (
    desc.includes("przelew własny") ||
    desc.includes("przelew wlasny") ||
    desc.includes("przelew wewnętrzny") && line.method === "transfer"
  ) {
    // These are internal-account transfers - skip auto-match.
    return { line_id: line.id, status: "skipped", reason: "internal_transfer" };
  }

  const cands = await findCandidates(sb, tenantId, line);
  if (cands.length === 0) return { line_id: line.id, status: "no_candidate" };

  // Pick the best score. If two candidates tie within 0.1% we treat it as
  // ambiguous and leave it pending (rare in practice).
  cands.sort((a, b) => a.score - b.score);
  if (cands.length > 1 && cands[1]!.score - cands[0]!.score < 0.001) {
    return { line_id: line.id, status: "ambiguous", candidate_count: cands.length };
  }
  return await applyMatch(sb, tenantId, line, cands[0]!);
}

/**
 * Batch: reconcile every pending line for a given statement.
 * Returns a summary suitable for posting back to the user.
 */
export interface ReconcileSummary {
  total: number;
  matched: number;
  ambiguous: number;
  no_candidate: number;
  skipped: number;
  outcomes: ReconcileOutcome[];
}

export async function reconcileStatement(
  sb: SupabaseClient,
  tenantId: string,
  statementId: string,
): Promise<ReconcileSummary> {
  const db = tenantDb(sb, tenantId);
  const linesRes = await db.from("bank_statement_lines")
    .select(
      "id, family_member_id, posted_date, amount, currency, description, method, kind, status",
    )
    .eq("statement_id", statementId)
    .eq("status", "pending");
  const lines = (linesRes.data ?? []) as BankLine[];

  const outcomes: ReconcileOutcome[] = [];
  for (const line of lines) {
    outcomes.push(await reconcileLine(sb, tenantId, line));
  }

  const summary: ReconcileSummary = {
    total: lines.length,
    matched: outcomes.filter((o) => o.status === "matched").length,
    ambiguous: outcomes.filter((o) => o.status === "ambiguous").length,
    no_candidate: outcomes.filter((o) => o.status === "no_candidate").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    outcomes,
  };
  return summary;
}
