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
const GREETING = /^(привет|здаров|здравствуй|hi|hello|hey|cześć|witaj|вітаю|спасибо|спс|thanks|thx|ок|ok|понятно|ясно)\b/i;

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
  if (t.endsWith("?")) return "question";
  if (QUESTION_WORDS.test(t)) return "question";
  if (GREETING.test(t)) return "question";
  const hasDigit = /\d/.test(t);
  if (hasDigit && CURRENCY_MARKERS.test(t)) return "expense";
  if (hasDigit) return "expense";
  return "question";
}
