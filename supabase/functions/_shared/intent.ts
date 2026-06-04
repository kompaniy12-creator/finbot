// Heuristic intent classifier for free-form user text.
// Decides whether a non-command message looks like an expense to record or
// like a question / chitchat that should go to the analyst agent.
//
// Cheap (regex only, no Claude call) so it runs on every incoming text
// before we decide which pipeline to invoke. Designed to err on the side of
// the analyst when uncertain: the analyst can always say "это была трата?
// сейчас запишу" and re-prompt the user, but the parser turning a question
// into a 0.01 PLN line item (the exact bug in the user's screenshot) is the
// failure mode we cannot afford.

export type Intent = "expense" | "question";

// Question lead-words across the four languages the family uses.
// Word-boundary anchored so "какой" matches but "какойто" or substrings don't.
const QUESTION_WORDS = new RegExp(
  "(^|[^\\p{L}])(" +
    // Russian
    "как|сколько|что|почему|зачем|когда|где|какой|какая|какое|какие|который|" +
    // Ukrainian
    "як|скільки|чому|коли|де|який|" +
    // Polish
    "jak|ile|dlaczego|kiedy|gdzie|który|" +
    // English
    "how|why|what|when|where|which|who|" +
    // Common imperatives for "show / tell" that route to analyst
    "покажи|расскажи|подскажи|объясни|посчитай|давай|можешь|можно|хочу|" +
    "show|tell|explain" +
    ")([^\\p{L}]|$)",
  "iu",
);

// Currency markers from parse_expense.ts (kept in sync, see SPEC §6.1).
const CURRENCY_MARKERS = new RegExp(
  "(zł|zl|pln|злот|złot|€|eur|евро|\\$|usd|долл|" +
    "лек|лека|леке|леков|леку|lek|leku|leke|lekë)",
  "i",
);

// A small whitelist of greetings / acknowledgements that should not get
// parsed as an expense even if some weird heuristic flips.
const GREETING =
  /^(привет|здаров|здравствуй|hi|hello|hey|cześć|witaj|вітаю|спасибо|спс|thanks|thx|ок|ok|понятно|ясно)\b/i;

// Strong analyst triggers. When the message contains any of these tokens,
// it goes to the analyst even if it also has digits/currency markers - so
// "Отметь овощи 18.45 PLN как card" doesn't get eaten by the expense
// parser. These describe ACTIONS over existing data, not new entries.
const ANALYST_OVERRIDES = new RegExp(
  "(^|[^\\p{L}])(" +
    // mark / reconcile / merge / consolidate
    "отметь|пометь|пометить|сверь|сверить|сверка|сверки|сопоставь|сопоставить|" +
    "сравни|сравнить|объедини|объединить|объединить|" +
    // bank-statement related
    "выписк|банк|кредитк|картой|наличными|" +
    // delete / change requests on existing data
    "удали|удалить|перенеси|поменяй|измени|" +
    // English analogues
    "reconcile|match|mark|merge|delete|change" +
    ")([^\\p{L}]|$)",
  "iu",
);

/**
 * Classify a free-form user message. See module docs for failure-mode notes.
 *
 * Rules in order:
 *   1. Ends with "?" or starts with question word → question (analyst).
 *   2. Greeting / acknowledgement → question (analyst will say hi back).
 *   3. Has a digit AND a currency marker → expense (parser).
 *   4. Has any digit at all → expense (PLN default; parser owns this case).
 *   5. Otherwise (text only, no signal) → question.
 */
export function classifyIntent(text: string): Intent {
  const t = text.trim();
  if (!t) return "question";
  // Strong analyst override BEFORE the digit/currency rule: an explicit
  // "отметь / сверь / выписка / удали" request must not be eaten by the
  // expense parser just because it happens to contain a number.
  if (ANALYST_OVERRIDES.test(t)) return "question";
  if (t.endsWith("?")) return "question";
  if (QUESTION_WORDS.test(t)) return "question";
  if (GREETING.test(t)) return "question";
  const hasDigit = /\d/.test(t);
  if (hasDigit && CURRENCY_MARKERS.test(t)) return "expense";
  if (hasDigit) return "expense";
  return "question";
}

// ---- Photo caption -> income/expense ------------------------------------
//
// When a user sends a photo (typically a bank-app screenshot) with a caption,
// the caption is the user's intent signal: "Зарплата" → income, "Lidl" or
// "Магазин" → expense. We're permissive about typos because users type these
// in a hurry on mobile.

// Income trigger words (verbs + nouns that imply incoming money) in the four
// languages the family uses. Substring match - we don't need word boundaries
// because false positives would require an income token to appear inside an
// unrelated word, which is vanishingly rare.
const INCOME_KEYWORDS = [
  // Russian + Ukrainian
  "зарплат",
  "зп",
  "аванс",
  "гонорар",
  "фриланс",
  "халтур",
  "темка",
  "темки",
  "дивиденд",
  "дивідент",
  "девиденд", // common misspelling
  "дивідент",
  "девідент",
  "кэшбэк",
  "кэшбек",
  "кешбек",
  "кешбэк",
  "cashback",
  "возврат",
  "вернул",
  "повернул",
  "подарок мне",
  "подарили",
  "подарунок",
  "получил",
  "получила",
  "прислали",
  "прислала",
  "пришла зарплат",
  "пришла зп",
  "пришл",
  "виплат",
  "выплат",
  "пенсия",
  "пенсі",
  // English
  "salary",
  "paycheck",
  "payroll",
  "freelance",
  "refund",
  "dividend",
  "gift",
  "income",
  "received",
  // Polish
  "wypłata",
  "wyplata",
  "pensja",
  "zwrot",
  "prezent",
  "premia",
];

// Pre-canned income category names (Russian, matches seed in migration 0018).
// Lowercased. We also include the most common typo variants the user has
// shown ("Девиденды").
const INCOME_CATEGORY_NAMES = [
  "зарплата",
  "дивиденды",
  "девиденды",
  "дивідент",
  "фриланс",
  "темки",
  "темка",
  "подарок",
  "возврат долгов",
  "прочий",
];

/**
 * Decide whether a photo (typically a bank receipt screenshot) should be
 * recorded as income or expense. Default is expense - that's the common case
 * (every store receipt). Returns "income" only when the caption clearly
 * signals it: a known income keyword or a (fuzzy) match against an income
 * category name.
 */
export function detectPhotoKind(caption: string): "expense" | "income" {
  const c = (caption || "").trim().toLowerCase();
  if (!c) return "expense";
  for (const kw of INCOME_KEYWORDS) {
    if (c.includes(kw)) return "income";
  }
  // Exact / starts-with match against income category names.
  for (const name of INCOME_CATEGORY_NAMES) {
    if (c === name || c.startsWith(name + " ") || c.endsWith(" " + name)) {
      return "income";
    }
  }
  return "expense";
}
