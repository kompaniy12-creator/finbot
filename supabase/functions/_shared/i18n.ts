// Minimal i18n for the SaaS onboarding wizard. Four locales: Ukrainian,
// Russian, Polish, English. t(locale, key, params) returns the localized
// string; unknown keys/locales fall back to Russian.

export type Locale = "uk" | "ru" | "pl" | "en";

export const LOCALES: Array<{ code: Locale; native: string; flag: string }> = [
  { code: "uk", native: "Українська", flag: "🇺🇦" },
  { code: "ru", native: "Русский", flag: "🇷🇺" },
  { code: "pl", native: "Polski", flag: "🇵🇱" },
  { code: "en", native: "English", flag: "🇬🇧" },
];

// Human-readable language name (in English) for instructing the model which
// language to answer in.
export const LOCALE_ENGLISH_NAME: Record<Locale, string> = {
  uk: "Ukrainian",
  ru: "Russian",
  pl: "Polish",
  en: "English",
};

export function isLocale(v: string): v is Locale {
  return v === "uk" || v === "ru" || v === "pl" || v === "en";
}

type Dict = Record<string, string>;

// {name} style placeholders are substituted from params.
const STRINGS: Record<Locale, Dict> = {
  uk: {
    debt_parse_failed:
      "Не зрозумів борг ({reason}). Спробуй чіткіше: «дав у борг Паші 1000 PLN до 15 липня».",
    debt_owed_to_me: "Винен мені",
    debt_i_owe: "Я винен",
    lbl_date: "Дата",
    lbl_due: "Термін",
    debt_saved: "✅ {verb}: {who} - {sum}\n{dateLbl}: {date}{due}",
    budget_parse_failed:
      "Не зрозумів бюджет ({reason}). Спробуй: «додай бюджет їжа 2000 PLN на місяць».",
    budget_cat_not_found:
      "Не знайшов категорію «{wanted}». Доступні:\n{list}\n\nПовтори з точною назвою, напр.: «бюджет {ex} 500 EUR».",
    per_weekly: "на тиждень",
    per_monthly: "на місяць",
    per_yearly: "на рік",
    budget_created:
      "✅ Бюджет створено: {cat} - {sum} {period}.\nПрогрес у вкладці Планування -> Бюджети.",
    voice_too_long: "Голосове задовге ({dur}s, ліміт {max}s).",
    voice_download_failed: "Не зміг завантажити голосове: {err}",
    voice_transcribe_failed: "Не зміг розпізнати: {err}",
    voice_lang_rejected: 'Розпізнав мову "{lang}" - не в списку (ru/uk/pl/en).',
    voice_no_text: "Не зрозумів, що записати. Скажи як «кава 12 zł».",
    voice_recognized: "Розпізнав: {text}",
    not_understood: "Не зрозумів, що записати. Спробуй: «кава 12 zł».",
    rec_saved: "Записав:",
    rec_saved_n: "Записав {n}:",
    rec_income_1: "💰 Дохід:",
    rec_income_n: "💰 {n} надходжень:",
    rec_mixed: "Записав {n} (дохід + витрата):",
    tag_high_uncat: " (велика сума + не впевнений у категорії)",
    tag_high: " (велика сума)",
    tag_uncat: " (категорія неточна)",
    total_all: "Всього",
    total_got: "Отримав",
    lbl_income: "Дохід",
    lbl_expense: "Витрата",
    mixed_ccy: " (різні валюти)",
    date_hint: "\n\n_Враховано за {months}. У дашборді перемкни на «Період», щоб побачити._",
    btn_yes: "Так",
    btn_edit: "Змінити",
    btn_cancel: "Скасувати",
    choose_lang: "👋 Вітаю! Це FinBot - твій помічник з фінансами.\n\n" +
      "Якою мовою спілкуватись? / Choose your language:",
    ask_name: "Чудово! Як до тебе звертатися?",
    ask_apikey: "Приємно познайомитись, {name}! 🙌\n\n" +
      "Щоб я розпізнавав твої витрати, потрібен твій ключ Anthropic " +
      "(кожен платить за свою витрату на ШІ).\n\n" +
      "Отримай його тут: https://console.anthropic.com/settings/keys\n" +
      "і просто надішли його сюди (починається з <code>sk-ant-</code>).",
    bad_apikey: "Це не схоже на ключ Anthropic (він починається з <code>sk-ant-</code>). " +
      "Спробуй ще раз.",
    ask_groqkey: "✅ Ключ збережено!\n\n" +
      "Якщо хочеш надсилати голосові, додай безкоштовний ключ Groq " +
      "(https://console.groq.com/keys) - надішли його сюди " +
      "(починається з <code>gsk_</code>) або натисни «Пропустити».",
    bad_groqkey: "Це не схоже на ключ Groq (він починається з <code>gsk_</code>). " +
      "Надішли ключ або натисни «Пропустити».",
    skip_btn: "Пропустити",
    done: "🎉 Готово, {name}! Все налаштовано.\n\n" +
      "Просто пиши витрати текстом («кава 12 zł»), надсилай фото чеків або голосові - " +
      "я все запишу й розкладу по категоріях. Відкрий «FinApp» у меню бота, щоб " +
      "бачити статистику, доходи, борги та кредити.",
    done_nogroq: "🎉 Готово, {name}! Все налаштовано.\n\n" +
      "Голосові можна підключити пізніше командою <code>/groqkey</code>. " +
      "А поки пиши витрати текстом або надсилай фото чеків. Відкрий «FinApp» у меню бота.",
  },
  ru: {
    debt_parse_failed:
      "Не смог распознать долг ({reason}). Попробуй явнее: «дал в долг Паше 1000 PLN до 15 июля».",
    debt_owed_to_me: "Должен мне",
    debt_i_owe: "Я должен",
    lbl_date: "Дата",
    lbl_due: "Срок",
    debt_saved: "✅ {verb}: {who} - {sum}\n{dateLbl}: {date}{due}",
    budget_parse_failed:
      "Не смог распознать бюджет ({reason}). Попробуй: «добавь бюджет еда 2000 PLN в месяц».",
    budget_cat_not_found:
      "Не нашёл категорию «{wanted}». Доступные:\n{list}\n\nПовтори с точным названием, например: «бюджет {ex} 500 EUR».",
    per_weekly: "в неделю",
    per_monthly: "в месяц",
    per_yearly: "в год",
    budget_created:
      "✅ Бюджет создан: {cat} - {sum} {period}.\nПрогресс смотри во вкладке Планирование -> Бюджеты.",
    voice_too_long: "Голосовое слишком длинное ({dur}s, лимит {max}s).",
    voice_download_failed: "Не смог скачать голосовое: {err}",
    voice_transcribe_failed: "Не смог распознать: {err}",
    voice_lang_rejected: 'Распознал язык "{lang}" - не в whitelist (ru/uk/pl/en).',
    voice_no_text: "Не понял, что записать. Скажи как «кофе 12 zł».",
    voice_recognized: "Распознал: {text}",
    not_understood: "Не понял, что записать. Попробуй: «кофе 12 zł».",
    rec_saved: "Записал:",
    rec_saved_n: "Записал {n}:",
    rec_income_1: "💰 Доход:",
    rec_income_n: "💰 {n} дохода:",
    rec_mixed: "Записал {n} (доход + расход):",
    tag_high_uncat: " (крупная сумма + не уверен в категории)",
    tag_high: " (крупная сумма)",
    tag_uncat: " (категория не точно)",
    total_all: "Всего",
    total_got: "Получил",
    lbl_income: "Доход",
    lbl_expense: "Расход",
    mixed_ccy: " (смешанные валюты)",
    date_hint: "\n\n_Учтено за {months}. В дашборде переключи на «Период», чтобы увидеть._",
    btn_yes: "Да",
    btn_edit: "Изменить",
    btn_cancel: "Отмена",
    choose_lang: "👋 Привет! Это FinBot - твой помощник по финансам.\n\n" +
      "На каком языке общаемся? / Choose your language:",
    ask_name: "Отлично! Как тебя зовут?",
    ask_apikey: "Приятно познакомиться, {name}! 🙌\n\n" +
      "Чтобы я распознавал твои траты, нужен твой ключ Anthropic " +
      "(каждый платит за свой расход на ИИ).\n\n" +
      "Получи его здесь: https://console.anthropic.com/settings/keys\n" +
      "и просто пришли его сюда (начинается с <code>sk-ant-</code>).",
    bad_apikey: "Это не похоже на ключ Anthropic (он начинается с <code>sk-ant-</code>). " +
      "Попробуй ещё раз.",
    ask_groqkey: "✅ Ключ сохранён!\n\n" +
      "Если хочешь слать голосовые, добавь бесплатный ключ Groq " +
      "(https://console.groq.com/keys) - пришли его сюда " +
      "(начинается с <code>gsk_</code>) или нажми «Пропустить».",
    bad_groqkey: "Это не похоже на ключ Groq (он начинается с <code>gsk_</code>). " +
      "Пришли ключ или нажми «Пропустить».",
    skip_btn: "Пропустить",
    done: "🎉 Готово, {name}! Всё настроено.\n\n" +
      "Просто пиши траты текстом («кофе 12 zł»), шли фото чеков или голосовые - " +
      "я всё запишу и разложу по категориям. Открой «FinApp» в меню бота, чтобы " +
      "видеть статистику, доходы, долги и кредиты.",
    done_nogroq: "🎉 Готово, {name}! Всё настроено.\n\n" +
      "Голосовые можно подключить позже командой <code>/groqkey</code>. " +
      "А пока пиши траты текстом или шли фото чеков. Открой «FinApp» в меню бота.",
  },
  pl: {
    debt_parse_failed:
      "Nie zrozumiałem długu ({reason}). Spróbuj wyraźniej: «pożyczyłem Pawłowi 1000 PLN do 15 lipca».",
    debt_owed_to_me: "Winni mi",
    debt_i_owe: "Jestem winien",
    lbl_date: "Data",
    lbl_due: "Termin",
    debt_saved: "✅ {verb}: {who} - {sum}\n{dateLbl}: {date}{due}",
    budget_parse_failed:
      "Nie zrozumiałem budżetu ({reason}). Spróbuj: «dodaj budżet jedzenie 2000 PLN na miesiąc».",
    budget_cat_not_found:
      "Nie znalazłem kategorii «{wanted}». Dostępne:\n{list}\n\nPowtórz z dokładną nazwą, np.: «budżet {ex} 500 EUR».",
    per_weekly: "na tydzień",
    per_monthly: "na miesiąc",
    per_yearly: "na rok",
    budget_created:
      "✅ Budżet utworzony: {cat} - {sum} {period}.\nPostęp w zakładce Planowanie -> Budżety.",
    voice_too_long: "Wiadomość głosowa za długa ({dur}s, limit {max}s).",
    voice_download_failed: "Nie udało się pobrać głosówki: {err}",
    voice_transcribe_failed: "Nie udało się rozpoznać: {err}",
    voice_lang_rejected: 'Wykryto język "{lang}" - poza listą (ru/uk/pl/en).',
    voice_no_text: "Nie zrozumiałem, co zapisać. Powiedz np. «kawa 12 zł».",
    voice_recognized: "Rozpoznano: {text}",
    not_understood: "Nie zrozumiałem, co zapisać. Spróbuj: «kawa 12 zł».",
    rec_saved: "Zapisałem:",
    rec_saved_n: "Zapisałem {n}:",
    rec_income_1: "💰 Przychód:",
    rec_income_n: "💰 {n} przychodów:",
    rec_mixed: "Zapisałem {n} (przychód + wydatek):",
    tag_high_uncat: " (duża kwota + niepewna kategoria)",
    tag_high: " (duża kwota)",
    tag_uncat: " (kategoria niepewna)",
    total_all: "Razem",
    total_got: "Otrzymano",
    lbl_income: "Przychód",
    lbl_expense: "Wydatek",
    mixed_ccy: " (różne waluty)",
    date_hint: "\n\n_Ujęto za {months}. W panelu przełącz na «Okres», aby zobaczyć._",
    btn_yes: "Tak",
    btn_edit: "Zmień",
    btn_cancel: "Anuluj",
    choose_lang: "👋 Cześć! To FinBot - twój pomocnik w finansach.\n\n" +
      "W jakim języku rozmawiamy? / Choose your language:",
    ask_name: "Świetnie! Jak masz na imię?",
    ask_apikey: "Miło Cię poznać, {name}! 🙌\n\n" +
      "Żebym rozpoznawał twoje wydatki, potrzebny jest twój klucz Anthropic " +
      "(każdy płaci za swoje zużycie AI).\n\n" +
      "Pobierz go tutaj: https://console.anthropic.com/settings/keys\n" +
      "i po prostu przyślij go tutaj (zaczyna się od <code>sk-ant-</code>).",
    bad_apikey: "To nie wygląda na klucz Anthropic (zaczyna się od <code>sk-ant-</code>). " +
      "Spróbuj jeszcze raz.",
    ask_groqkey: "✅ Klucz zapisany!\n\n" +
      "Jeśli chcesz wysyłać wiadomości głosowe, dodaj darmowy klucz Groq " +
      "(https://console.groq.com/keys) - przyślij go tutaj " +
      "(zaczyna się od <code>gsk_</code>) lub naciśnij «Pomiń».",
    bad_groqkey: "To nie wygląda na klucz Groq (zaczyna się od <code>gsk_</code>). " +
      "Przyślij klucz lub naciśnij «Pomiń».",
    skip_btn: "Pomiń",
    done: "🎉 Gotowe, {name}! Wszystko skonfigurowane.\n\n" +
      "Po prostu pisz wydatki tekstem («kawa 12 zł»), wysyłaj zdjęcia paragonów lub głosówki - " +
      "wszystko zapiszę i przypiszę do kategorii. Otwórz «FinApp» w menu bota, aby " +
      "zobaczyć statystyki, dochody, długi i kredyty.",
    done_nogroq: "🎉 Gotowe, {name}! Wszystko skonfigurowane.\n\n" +
      "Wiadomości głosowe możesz podłączyć później komendą <code>/groqkey</code>. " +
      "Na razie pisz wydatki tekstem lub wysyłaj zdjęcia paragonów. Otwórz «FinApp» w menu bota.",
  },
  en: {
    debt_parse_failed:
      'Couldn\'t parse the debt ({reason}). Try clearer: "lent Pasha 1000 PLN until July 15".',
    debt_owed_to_me: "Owes me",
    debt_i_owe: "I owe",
    lbl_date: "Date",
    lbl_due: "Due",
    debt_saved: "✅ {verb}: {who} - {sum}\n{dateLbl}: {date}{due}",
    budget_parse_failed:
      'Couldn\'t parse the budget ({reason}). Try: "add budget food 2000 PLN per month".',
    budget_cat_not_found:
      'Category «{wanted}» not found. Available:\n{list}\n\nRetry with the exact name, e.g.: "budget {ex} 500 EUR".',
    per_weekly: "per week",
    per_monthly: "per month",
    per_yearly: "per year",
    budget_created:
      "✅ Budget created: {cat} - {sum} {period}.\nSee progress in Planning -> Budgets.",
    voice_too_long: "Voice message too long ({dur}s, limit {max}s).",
    voice_download_failed: "Couldn't download the voice: {err}",
    voice_transcribe_failed: "Couldn't transcribe: {err}",
    voice_lang_rejected: 'Detected language "{lang}" - not in whitelist (ru/uk/pl/en).',
    voice_no_text: 'Didn\'t catch what to record. Say e.g. "coffee 12 zł".',
    voice_recognized: "Recognized: {text}",
    not_understood: 'Didn\'t catch what to record. Try: "coffee 12 zł".',
    rec_saved: "Recorded:",
    rec_saved_n: "Recorded {n}:",
    rec_income_1: "💰 Income:",
    rec_income_n: "💰 {n} income entries:",
    rec_mixed: "Recorded {n} (income + expense):",
    tag_high_uncat: " (large amount + unsure category)",
    tag_high: " (large amount)",
    tag_uncat: " (category uncertain)",
    total_all: "Total",
    total_got: "Received",
    lbl_income: "Income",
    lbl_expense: "Expense",
    mixed_ccy: " (mixed currencies)",
    date_hint: "\n\n_Counted for {months}. In the dashboard switch to «Period» to see it._",
    btn_yes: "Yes",
    btn_edit: "Edit",
    btn_cancel: "Cancel",
    choose_lang: "👋 Hi! This is FinBot - your finance assistant.\n\n" +
      "Which language should we use? / Choose your language:",
    ask_name: "Great! What's your name?",
    ask_apikey: "Nice to meet you, {name}! 🙌\n\n" +
      "To read your expenses I need your own Anthropic key " +
      "(everyone pays for their own AI usage).\n\n" +
      "Get it here: https://console.anthropic.com/settings/keys\n" +
      "and just send it here (starts with <code>sk-ant-</code>).",
    bad_apikey: "That doesn't look like an Anthropic key (it starts with <code>sk-ant-</code>). " +
      "Please try again.",
    ask_groqkey: "✅ Key saved!\n\n" +
      "If you want to send voice messages, add a free Groq key " +
      "(https://console.groq.com/keys) - send it here " +
      "(starts with <code>gsk_</code>) or tap «Skip».",
    bad_groqkey: "That doesn't look like a Groq key (it starts with <code>gsk_</code>). " +
      "Send the key or tap «Skip».",
    skip_btn: "Skip",
    done: "🎉 All set, {name}!\n\n" +
      "Just type expenses («coffee 12 zł»), send receipt photos or voice notes - " +
      "I'll record everything and sort it into categories. Open «FinApp» in the bot menu to " +
      "see stats, income, debts and credits.",
    done_nogroq: "🎉 All set, {name}!\n\n" +
      "You can add voice support later with <code>/groqkey</code>. " +
      "For now, type expenses or send receipt photos. Open «FinApp» in the bot menu.",
  },
};

export function t(locale: string, key: string, params?: Record<string, string>): string {
  const loc: Locale = isLocale(locale) ? locale : "ru";
  let s = STRINGS[loc][key] ?? STRINGS.ru[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v);
  }
  return s;
}
