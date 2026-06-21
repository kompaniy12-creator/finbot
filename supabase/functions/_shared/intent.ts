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

export type Intent = "expense" | "question" | "debt" | "budget";

// Budget-creation triggers. "Добавь бюджет еда 2000", "установи лимит на
// транспорт 300 EUR" - a create verb + a budget noun + a number. Caught BEFORE
// the expense parser so "бюджет ... 150 евро" is not recorded as a 150 EUR
// expense (the exact bug from the user's screenshot). A bare question like
// "сколько в бюджете?" has no create verb and is left to the analyst.
const BUDGET_NOUN = new RegExp(
  "(^|[^\\p{L}])(бюджет\\p{L}*|лимит\\p{L}*|ліміт\\p{L}*|budget|limit)([^\\p{L}]|$)",
  "iu",
);
const BUDGET_VERB = new RegExp(
  "(^|[^\\p{L}])(" +
    "добав\\p{L}*|созда\\p{L}*|установ\\p{L}*|встанов\\p{L}*|задай|постав\\p{L}*|" +
    "нов\\p{L}*|сдела\\p{L}*|add|set|create|make" +
    ")([^\\p{L}]|$)",
  "iu",
);

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

// Debt-creation triggers. "1000 дал в долг Паше", "взял у Маши 500",
// "одолжил подруге 200 EUR" - these create a debts row, not an
// expense or a question. Caught BEFORE the expense-parser path so
// the digit+currency rule doesn't snatch them away.
const DEBT_PATTERNS = new RegExp(
  "(^|[^\\p{L}])(" +
    // Russian: "дал/даю в долг", "одолжил/-а", "занял/-а N у кого", "взял в долг", "должен мне/я"
    "дал\\s+в\\s+долг|даю\\s+в\\s+долг|одолжи(л|ла|ть|у)|" +
    "взял\\s+в\\s+долг|взяла\\s+в\\s+долг|" +
    "(должен|должна)\\s+(мне|нам)|я\\s+должен|я\\s+должна|" +
    "занял\\s+у|заняла\\s+у|" +
    // Ukrainian
    "позичи(в|ла|ти)|" +
    // Polish
    "pożyczy(łem|łam|ć)|" +
    // English
    "lent|borrowed|owes\\s+me|i\\s+owe|loan(ed)?" +
    ")([^\\p{L}]|$)",
  "iu",
);

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

// Lines that are running totals / subtotals, not separate expenses. Skipped
// when counting item lines (and the parser is told to skip them too).
const TOTAL_LINE = new RegExp(
  "^\\s*(?:💰|💵|🧾|🛒)?\\s*(итого|всего|чек|сумма|подытог|разом|разаом|total|sum|subtotal)\\b",
  "iu",
);
// A list item line: has a name (letters) and an amount, joined by a "-"/":"
// separator ("Maxi - 1620 lek") or carrying a currency marker ("Spar 2950 lek").
// Separator chars users type between a name and an amount: hyphen, en dash
// (U+2013), em dash (U+2014) or colon. The two long dashes are written as
// escapes so the no-em-dash source hook stays happy.
const ITEM_SEP_AMOUNT = /[-\u2013\u2014:]\s*\d[\d\s.,]*/u;

/**
 * A pasted bulk list of expenses, e.g.
 *   Финансы: 01.06.2026
 *   Maxi - 1620 lek
 *   Spar - 2950 lek
 * Two or more item lines (name + amount, skipping totals) means the user is
 * dumping a batch to record, even if the surrounding prose contains a question
 * word like "что-то" ("если что-то уже было"). Detected BEFORE the question-word
 * rules so such a list reaches the expense parser instead of the analyst.
 */
export function looksLikeBulkList(text: string): boolean {
  let items = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || TOTAL_LINE.test(l)) continue;
    if (!/\d/.test(l) || !/\p{L}/u.test(l)) continue; // need a name AND a number
    if (ITEM_SEP_AMOUNT.test(l) || CURRENCY_MARKERS.test(l)) items++;
    if (items >= 2) return true;
  }
  return false;
}

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
  // Debt-creation phrases beat both the analyst and the expense parser:
  // "1000 дал в долг Паше" must become a debt row, not a 1000-PLN
  // expense in 'Выплаты по кредиту' (the existing wrong behavior).
  if (DEBT_PATTERNS.test(t)) return "debt";
  // Budget creation: verb + budget-noun + a number. Before the analyst override
  // and the expense rule so it is not eaten by either.
  if (BUDGET_NOUN.test(t) && BUDGET_VERB.test(t) && /\d/.test(t)) return "budget";
  // Strong analyst override BEFORE the digit/currency rule: an explicit
  // "отметь / сверь / выписка / удали" request must not be eaten by the
  // expense parser just because it happens to contain a number.
  if (ANALYST_OVERRIDES.test(t)) return "question";
  // A pasted multi-item list is a batch to record, even if its prose contains a
  // question word. Beats the "?" / question-word rules below.
  if (looksLikeBulkList(t)) return "expense";
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
  "wynagrodzenie", // "remuneration", common in salary statement lines
  "wynagrodzeni", // catches inflections
  "przelew przychodzący", // mBank: "incoming transfer"
  "przelew wewnętrzny przychodzący", // mBank specific
  "uznanie", // mBank inflow column heading
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
