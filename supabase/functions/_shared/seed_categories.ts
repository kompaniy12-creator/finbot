// Seed the default category catalogue for a freshly-created tenant (used by the
// SaaS-bot onboarding flow). Categories are inserted WITHOUT embeddings: the
// gte-small model runs in-process and embedding 30+ rows inline would blow the
// Edge Function CPU budget during onboarding. Embeddings are a kNN nicety and
// get filled lazily (cron-retraining / first corrections); seeding never needs
// them. Mirrors the catalogue in setup-once/index.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantDb } from "./tenant_db.ts";
import { log } from "./log.ts";

export interface SeedCategory {
  name: string;
  description: string;
  kind?: "expense" | "income";
  isFallback?: boolean;
}

export const SEED_CATEGORIES: SeedCategory[] = [
  { name: "Питание продукты", description: "Groceries, supermarket food, pantry essentials" },
  { name: "Питание заведения", description: "Restaurants, cafes, takeaway, fast food, bars" },
  { name: "Алкоголь", description: "Alcohol: wine, beer, spirits, liquor store" },
  {
    name: "Комунальные расходы + аренда",
    description: "Rent, mortgage, utilities, electricity, gas, water",
  },
  {
    name: "Мобильная связь + интернет",
    description: "Mobile plan, internet provider, landline, hosting",
  },
  { name: "Одежда, обувь, аксесуары", description: "Clothing, footwear, accessories, bags" },
  { name: "Транспорт", description: "Public transport, taxi, parking, fuel, gasoline" },
  { name: "Развлечения", description: "Movies, concerts, events, streaming, games, books" },
  { name: "Отдых, поездки", description: "Travel, hotels, flights, vacation, car rental" },
  { name: "Обучение", description: "Courses, school fees, tutoring, workshops, books" },
  { name: "Расходы на родителей", description: "Support, gifts and help for parents" },
  {
    name: "Расходы на любимого человека",
    description: "Spending on partner, romantic gifts, dates",
  },
  { name: "Уход за собой", description: "Cosmetics, hair salon, barber, spa, grooming" },
  { name: "Уход за домом", description: "Cleaning supplies, household chemicals, laundry" },
  { name: "Здоровье, спорт", description: "Pharmacy, doctors, dental, gym, supplements" },
  { name: "Подарки", description: "Presents for friends, colleagues, birthdays" },
  { name: "Выплаты по кредиту", description: "Loan repayments, credit card payments, financing" },
  { name: "Домашние животные", description: "Pet food, veterinarian, grooming, toys" },
  {
    name: "Уличные животные",
    description: "Helping street animals: food for strays, rescue support",
  },
  { name: "Хобби, увлечения", description: "Hobby supplies, craft materials, instruments" },
  {
    name: "Обеспечение страховых програм",
    description: "Insurance premiums: health, car, home, life",
  },
  { name: "Ремонт (мебель, техника)", description: "Furniture, appliances, electronics, repairs" },
  {
    name: "Расходы на инвестирование",
    description: "Investments, brokerage fees, stocks, deposits, crypto",
  },
  {
    name: "Расходы на благотворительность",
    description: "Charity donations, NGO contributions, alms",
  },
  {
    name: "Дополнительные расходы",
    description: "Miscellaneous expenses that do not fit other categories",
    isFallback: true,
  },
  { name: "Зарплата", description: "Salary, monthly wage, paycheck", kind: "income" },
  {
    name: "Дивиденды",
    description: "Dividends, equity payouts, investment income",
    kind: "income",
  },
  { name: "Фриланс", description: "Freelance income, contract work, consulting", kind: "income" },
  { name: "Темки", description: "Side gigs, one-off deals, informal earnings", kind: "income" },
  { name: "Подарок", description: "Gifts received, monetary presents", kind: "income" },
  { name: "Возврат долгов", description: "Loan repayments received, debts repaid", kind: "income" },
  {
    name: "Прочий",
    description: "Other income, miscellaneous earnings",
    kind: "income",
    isFallback: true,
  },
];

/**
 * Insert the default catalogue for a tenant. Idempotent via upsert on
 * (tenant_id, name, kind). Returns the number of categories written.
 */
export async function seedCategoriesForTenant(
  sb: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const db = tenantDb(sb, tenantId);
  const rows = SEED_CATEGORIES.map((c) => ({
    name: c.name,
    description: c.description,
    kind: c.kind ?? "expense",
    is_fallback: c.isFallback ?? false,
    embedding: null,
  }));
  const ins = await db.from("categories").upsert(rows, {
    onConflict: "tenant_id,name,kind",
    ignoreDuplicates: true,
  });
  if (ins.error) {
    log("error", "seed_categories_failed", { tenant_id: tenantId, error: ins.error.message });
    return 0;
  }
  log("info", "seed_categories_done", { tenant_id: tenantId, count: rows.length });
  return rows.length;
}
