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
import { log } from "../_shared/log.ts";

const envSchema = z.object({
  CRON_SECRET: z.string().min(20),
});

// Names are user-facing (Russian). Descriptions stay English because they
// are fed to Supabase.ai gte-small for the category centroid embedding;
// gte-small is English-trained and degrades on Cyrillic input.
const CATEGORIES = [
  {
    name: "Продукты",
    description: "Food and household groceries from supermarkets",
  },
  {
    name: "Кафе и рестораны",
    description: "Eating out, coffee shops, bars, takeaway",
  },
  {
    name: "Транспорт",
    description: "Public transport, taxis, ride-sharing, parking",
  },
  { name: "Топливо", description: "Gasoline, diesel, EV charging" },
  {
    name: "Жильё",
    description: "Rent, mortgage payment, utilities, repairs, building fees",
  },
  {
    name: "Связь и интернет",
    description: "Internet, mobile data, landline, hosting",
  },
  {
    name: "Здоровье и аптеки",
    description: "Pharmacy, doctors, medical procedures, dental, optical",
  },
  {
    name: "Одежда и обувь",
    description: "Apparel, shoes, accessories, alterations",
  },
  {
    name: "Дом и быт",
    description: "Furniture, appliances, household items, decor, tools",
  },
  {
    name: "Дети",
    description: "Kids' clothing, toys, school supplies, childcare, kid activities",
  },
  {
    name: "Развлечения",
    description: "Movies, concerts, games, hobbies, books, magazines",
  },
  {
    name: "Подписки и сервисы",
    description: "Streaming services, software, online services, memberships",
  },
  { name: "Подарки", description: "Presents for others, donations" },
  {
    name: "Образование",
    description: "Books, courses, school fees, tutoring, workshops",
  },
  {
    name: "Путешествия",
    description: "Tickets, hotels, vacation expenses, vehicle rental",
  },
  {
    name: "Налоги и сборы",
    description: "Taxes, government fees, fines, bank fees",
  },
  {
    name: "Прочее",
    description: "Miscellaneous expenses that do not fit other categories",
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

  const { count: existingCount, error: countErr } = await sb
    .from("categories")
    .select("*", { count: "exact", head: true });
  if (countErr) {
    log("error", "setup_once_count_failed", { error: countErr.message });
    return new Response(
      JSON.stringify({ ok: false, error: countErr.message }),
      { status: 500 },
    );
  }

  if ((existingCount ?? 0) >= CATEGORIES.length) {
    log("info", "setup_once_skipped_already_seeded", {
      existing: existingCount,
    });
    return Response.json({
      ok: true,
      message: "already seeded",
      categories: existingCount,
    });
  }

  // Generate embeddings via Supabase.ai gte-small and insert categories.
  // @ts-ignore: Supabase global is runtime-only.
  const session = new Supabase.ai.Session("gte-small");

  let inserted = 0;
  for (const cat of CATEGORIES) {
    // Skip if name already present (resume-friendly)
    const { data: existing } = await sb
      .from("categories")
      .select("id")
      .eq("name", cat.name)
      .maybeSingle();
    if (existing) continue;

    const embedding = await session.run(cat.description, {
      mean_pool: true,
      normalize: true,
    });

    const { error: insertErr } = await sb.from("categories").insert({
      name: cat.name,
      description: cat.description,
      embedding,
      is_fallback: cat.isFallback ?? false,
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
      const { data: existing } = await sb
        .from("family_members")
        .select("id")
        .eq("telegram_id", m.telegram_id)
        .maybeSingle();
      if (existing) continue;

      const { error: insertErr } = await sb.from("family_members").insert({
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
    family_inserted: familyInserted,
  });

  return Response.json({
    ok: true,
    categories_inserted: inserted,
    family_inserted: familyInserted,
  });
});
