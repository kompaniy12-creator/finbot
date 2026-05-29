// Tip parser for photo captions / receipt-companion messages.
// Recognises:
//   "чаевые 100 лек"       -> 100 ALL
//   "tip 5 EUR"            -> 5 EUR
//   "100 лек чаевые"       -> 100 ALL
//   "+100 ALL tip"         -> 100 ALL
//   "5.50 zł чай"          -> 5.5 PLN
// Returns null if nothing matched.

export type TipCurrency = "PLN" | "EUR" | "ALL" | "USD";

const CCY_ALIASES: Array<[RegExp, TipCurrency]> = [
  [/лек(?:а|е|у|ов)?|leku|leke|^lek$|^l$/i, "ALL"],
  [/\ball\b/i, "ALL"],
  [/zł|zl|pln|злот/i, "PLN"],
  [/eur|евро|€/i, "EUR"],
  [/usd|долл|\$/i, "USD"],
];

function detectCurrency(s: string): TipCurrency | null {
  for (const [re, ccy] of CCY_ALIASES) if (re.test(s)) return ccy;
  return null;
}

const TIP_WORDS = /чаев|tip\b|tips\b|чай(?:\b|и)/i;
const NUMBER = /(\d+(?:[.,]\d+)?)/;

/**
 * Try to extract a tip line from a free-form caption. Returns the amount,
 * a stripped caption (tip phrase removed - so the rest can still feed
 * into Vision as a category hint), and the detected currency (or null,
 * in which case the caller should fall back to the receipt's currency).
 */
export interface TipParse {
  amount: number;
  currency: TipCurrency | null;
  remainder: string;
}

export function parseTip(caption: string): TipParse | null {
  if (!caption) return null;
  if (!TIP_WORDS.test(caption)) return null;
  const numMatch = caption.match(NUMBER);
  if (!numMatch) return null;
  const raw = numMatch[1]!.replace(",", ".");
  const amount = Number(raw);
  if (!isFinite(amount) || amount <= 0) return null;
  const currency = detectCurrency(caption);
  // Strip the tip phrase + amount so the leftover can be used as Vision hint.
  const remainder = caption
    .replace(NUMBER, " ")
    .replace(TIP_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { amount, currency, remainder };
}
