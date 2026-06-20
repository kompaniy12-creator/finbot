// setup-once Edge Function
// FinBot M2: one-shot seed for 17 categories (with gte-small embeddings)
// and family_members. Idempotent: skips if categories already seeded.
//
// Auth: x-setup-secret header must equal CRON_SECRET.
// Family payload: x-setup-family header carries JSON [{name, telegram_id, role}, ...].
//
// Invoked manually with curl. Not on any schedule.

import { z } from "zod";
import { adminClient } from "../_shared/supabase.ts";
import { tenantDb } from "../_shared/tenant_db.ts";
import { FAMILY_TENANT } from "../_shared/claude.ts";
import { log } from "../_shared/log.ts";

const envSchema = z.object({
  CRON_SECRET: z.string().min(20),
});

// Names are user-facing (Russian). Descriptions stay English because they
// are fed to Supabase.ai gte-small for the category centroid embedding;
// gte-small is English-trained and degrades on Cyrillic input.
const CATEGORIES = [
  {
    name: "Питание продукты",
    description: "Groceries, supermarket food, pantry essentials, household food",
  },
  {
    name: "Питание заведения",
    description: "Restaurants, cafes, coffee shops, takeaway, fast food, bars",
  },
  {
    name: "Алкоголь",
    description: "Alcohol: wine, beer, spirits, liquor store purchases",
  },
  {
    name: "Комунальные расходы + аренда",
    description: "Rent, mortgage, utilities, electricity, gas, water, building fees",
  },
  {
    name: "Мобильная связь + интернет",
    description: "Mobile phone plan, internet provider, landline, hosting fees",
  },
  {
    name: "Одежда, обувь, аксесуары",
    description: "Clothing, footwear, fashion accessories, jewelry, bags, alterations",
  },
  {
    name: "Транспорт",
    description: "Public transport, taxi, ride-sharing, parking, fuel, gasoline",
  },
  {
    name: "Развлечения",
    description: "Movies, concerts, theme parks, events, streaming, games, books",
  },
  {
    name: "Отдых, поездки",
    description: "Travel, hotels, flights, vacation expenses, car rental, tours",
  },
  {
    name: "Обучение",
    description: "Courses, school fees, tutoring, workshops, learning materials, books",
  },
  {
    name: "Расходы на родителей",
    description: "Support, gifts, and help for parents and family elders",
  },
  {
    name: "Расходы на любимого человека",
    description: "Spending on partner, romantic gifts, dates, anniversary presents",
  },
  {
    name: "Уход за собой",
    description: "Cosmetics, hair salon, barber, spa, beauty, personal grooming",
  },
  {
    name: "Уход за домом",
    description: "Cleaning supplies, household chemicals, laundry, home maintenance",
  },
  {
    name: "Здоровье, спорт",
    description: "Pharmacy, doctors, dental, gym, sports gear, supplements, fitness",
  },
  {
    name: "Подарки",
    description: "Presents for friends, colleagues, birthdays, occasions",
  },
  {
    name: "Выплаты по кредиту",
    description: "Loan repayments, credit card payments, mortgage interest, financing",
  },
  {
    name: "Домашние животные",
    description: "Pet food, veterinarian, grooming, toys, pet accessories",
  },
  {
    name: "Уличные животные",
    description:
      "Helping street animals: food for stray dogs and cats, animal welfare donations, feeding strays, rescue support",
  },
  {
    name: "Хобби, увлечения",
    description: "Hobby supplies, craft materials, musical instruments, collecting",
  },
  {
    name: "Обеспечение страховых програм",
    description: "Insurance premiums: health, car, home, life, travel insurance",
  },
  {
    name: "Ремонт (мебель, техника)",
    description: "Furniture, appliances, electronics, repair services, home equipment",
  },
  {
    name: "Расходы на инвестирование",
    description: "Investments, brokerage fees, stock purchases, savings deposits, crypto",
  },
  {
    name: "Расходы на благотворительность",
    description: "Charity donations, helping strangers, NGO contributions, alms",
  },
  {
    name: "Дополнительные расходы",
    description: "Miscellaneous expenses that do not fit other categories",
    isFallback: true,
  },
  // ---- Income categories (kind='income') ------------------------------
  // "Прочий" is the income fallback. is_fallback semantics are per-kind:
  // we keep one fallback per kind, validated implicitly here.
  {
    name: "Зарплата",
    description: "Salary, monthly wage, paycheck, primary employment income",
    kind: "income",
  },
  {
    name: "Дивиденды",
    description:
      "Dividends, stock dividends, equity payouts, investment income, capital distributions",
    kind: "income",
  },
  {
    name: "Фриланс",
    description: "Freelance income, contract work, consulting fees, side project earnings",
    kind: "income",
  },
  {
    name: "Темки",
    description: "Side gigs, hustles, one-off deals, ad-hoc opportunities, informal earnings",
    kind: "income",
  },
  {
    name: "Подарок",
    description: "Gifts received, monetary presents from family or friends, birthday money",
    kind: "income",
  },
  {
    name: "Возврат долгов",
    description: "Loan repayments received, money returned, debts repaid back to me",
    kind: "income",
  },
  {
    name: "Прочий",
    description: "Other income, miscellaneous earnings, unclassified positive cash flow",
    kind: "income",
    isFallback: true,
  },
];

const FamilyMemberInputSchema = z.object({
  name: z.string().min(1),
  telegram_id: z.number().int(),
  role: z.enum(["admin", "member"]).default("member"),
  username: z.string().optional(),
});
type FamilyMemberInput = z.infer<typeof FamilyMemberInputSchema>;

Deno.serve(async (req: Request) => {
  let env: { CRON_SECRET: string };
  try {
    env = envSchema.parse({ CRON_SECRET: Deno.env.get("CRON_SECRET") });
  } catch (err) {
    log("error", "setup_once_env_missing", { error: (err as Error).message });
    return new Response("server misconfigured", { status: 500 });
  }

  if (req.headers.get("x-setup-secret") !== env.CRON_SECRET) {
    log("warn", "setup_once_forbidden", {});
    return new Response("forbidden", { status: 401 });
  }

  const sb = adminClient();
  // setup-once only seeds the family tenant; scope all writes/reads to it.
  const db = tenantDb(sb, FAMILY_TENANT);

  const { count: existingCount, error: countErr } = await db
    .from("categories")
    .select("*", { count: "exact", head: true });
  if (countErr) {
    log("error", "setup_once_count_failed", { error: countErr.message });
    return new Response(
      JSON.stringify({ ok: false, error: countErr.message }),
      { status: 500 },
    );
  }

  // Note: we used to short-circuit here when existingCount >= CATEGORIES.length,
  // but that prevents the refresh loop below from upgrading zero-vector
  // placeholders (left behind by migrations that can't run gte-small inline)
  // into real embeddings. The refresh loop is itself idempotent - it only
  // touches rows whose embedding is a zero vector - so we let it run every time.
  void existingCount;

  // Generate embeddings via Supabase.ai gte-small and insert categories.
  // @ts-ignore: Supabase global is runtime-only.
  const session = new Supabase.ai.Session("gte-small");

  let inserted = 0;
  let refreshed = 0;
  for (const cat of CATEGORIES) {
    const kind = (cat as { kind?: string }).kind ?? "expense";
    // Resume-friendly: if a row exists, only refresh the embedding when it
    // looks like a zero-vector placeholder (set by migration 0018, where we
    // couldn't run gte-small inline) - otherwise leave it alone.
    const { data: existing } = await db
      .from("categories")
      .select("id, embedding, kind")
      .eq("name", cat.name)
      .maybeSingle();

    if (existing) {
      const row = existing as { id: string; embedding: unknown; kind: string | null };
      const emb = row.embedding as number[] | string | null;
      // pgvector serialises to "[0,0,...]" over JSON; both shapes possible.
      const isPlaceholder =
        (typeof emb === "string" && /^\[\s*0(\.0+)?(\s*,\s*0(\.0+)?)*\s*\]$/.test(emb)) ||
        (Array.isArray(emb) && emb.every((v) => v === 0));
      if (isPlaceholder) {
        const embedding = await session.run(cat.description, {
          mean_pool: true,
          normalize: true,
        });
        const upd = await db.from("categories").update({
          embedding,
          description: cat.description,
          kind,
          is_fallback: cat.isFallback ?? false,
        }).eq("id", row.id);
        if (upd.error) {
          log("error", "setup_once_refresh_category_failed", {
            name: cat.name,
            error: upd.error.message,
          });
          return Response.json({ ok: false, error: upd.error.message }, { status: 500 });
        }
        refreshed++;
      }
      continue;
    }

    const embedding = await session.run(cat.description, {
      mean_pool: true,
      normalize: true,
    });

    const { error: insertErr } = await db.from("categories").insert({
      name: cat.name,
      description: cat.description,
      embedding,
      is_fallback: cat.isFallback ?? false,
      kind,
    });
    if (insertErr) {
      log("error", "setup_once_insert_category_failed", {
        name: cat.name,
        error: insertErr.message,
      });
      return Response.json({ ok: false, error: insertErr.message }, {
        status: 500,
      });
    }
    inserted++;
  }
  log("info", "setup_once_seed_summary", { inserted, refreshed });

  // Family members from x-setup-family JSON header
  const familyHeader = req.headers.get("x-setup-family");
  let familyInserted = 0;
  if (familyHeader) {
    let members: FamilyMemberInput[];
    try {
      const raw = JSON.parse(familyHeader);
      members = z.array(FamilyMemberInputSchema).parse(raw);
    } catch (err) {
      log("error", "setup_once_family_parse_failed", {
        error: (err as Error).message,
      });
      return Response.json({ ok: false, error: "bad x-setup-family JSON" }, {
        status: 400,
      });
    }

    for (const m of members) {
      // Idempotent: skip if telegram_id already exists
      const { data: existing } = await db
        .from("family_members")
        .select("id")
        .eq("telegram_id", m.telegram_id)
        .maybeSingle();
      if (existing) continue;

      const { error: insertErr } = await db.from("family_members").insert({
        name: m.name,
        telegram_id: m.telegram_id,
        username: m.username ?? null,
        role: m.role,
        active: true,
      });
      if (insertErr) {
        log("error", "setup_once_insert_family_failed", {
          telegram_id: m.telegram_id,
          error: insertErr.message,
        });
        return Response.json({ ok: false, error: insertErr.message }, {
          status: 500,
        });
      }
      familyInserted++;
    }
  }

  log("info", "setup_once_completed", {
    categories_inserted: inserted,
    categories_refreshed: refreshed,
    family_inserted: familyInserted,
  });

  return Response.json({
    ok: true,
    categories_inserted: inserted,
    categories_refreshed: refreshed,
    family_inserted: familyInserted,
  });
});
