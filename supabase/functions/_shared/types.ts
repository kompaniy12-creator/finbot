import { z } from "zod";

export const CurrencySchema = z.enum(["PLN", "EUR", "ALL", "USD"]);
export type Currency = z.infer<typeof CurrencySchema>;

export const RoleSchema = z.enum(["admin", "member"]);
export type Role = z.infer<typeof RoleSchema>;

export const FamilyMemberSchema = z.object({
  id: z.string().uuid(),
  telegram_id: z.number().int(),
  username: z.string().nullable().optional(),
  name: z.string(),
  role: RoleSchema,
  active: z.boolean(),
  created_at: z.string().optional(),
});
export type FamilyMember = z.infer<typeof FamilyMemberSchema>;

export const CategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  examples: z.string().nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  usage_count: z.number().int(),
  is_fallback: z.boolean(),
  embedding: z.array(z.number()).length(384).nullable().optional(),
  centroid_updated_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type Category = z.infer<typeof CategorySchema>;

export const ExpenseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  name_normalized: z.string().nullable().optional(),
  expense_date: z.string(),
  amount: z.number(),
  currency: CurrencySchema,
  amount_pln: z.number(),
  category_id: z.string().uuid(),
  family_member_id: z.string().uuid(),
  source: z.enum(["voice", "photo", "text"]),
  description: z.string().nullable().optional(),
  receipt_id: z.string().uuid().nullable().optional(),
  confidence: z.number().min(0).max(1).default(1),
  needs_review: z.boolean(),
  needs_confirmation: z.boolean(),
  archived: z.boolean(),
  corrected_by_user: z.boolean(),
  embedding: z.array(z.number()).length(384).nullable().optional(),
  telegram_message_id: z.number().int().nullable().optional(),
  line_index: z.number().int().default(0),
  created_at: z.string().optional(),
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const ReceiptItemSchema = z.object({
  name: z.string(),
  amount: z.number(),
  qty: z.number().optional(),
});
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;

export const ReceiptSchema = z.object({
  id: z.string().uuid(),
  merchant: z.string().nullable().optional(),
  receipt_date: z.string(),
  currency: CurrencySchema,
  total: z.number(),
  total_pln: z.number(),
  photo_path: z.string().nullable().optional(),
  photo_purged_at: z.string().nullable().optional(),
  raw_ocr: z.unknown().nullable().optional(),
  items: z.array(ReceiptItemSchema).nullable().optional(),
  family_member_id: z.string().uuid(),
  telegram_message_id: z.number().int().nullable().optional(),
  archived: z.boolean(),
  created_at: z.string().optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

export const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
});

export const TelegramMessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  date: z.number().int(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: z.object({
    duration: z.number(),
    file_id: z.string(),
    mime_type: z.string().optional(),
  }).optional(),
  photo: z.array(z.object({
    file_id: z.string(),
    file_unique_id: z.string(),
    width: z.number(),
    height: z.number(),
    file_size: z.number().optional(),
  })).optional(),
  document: z.object({
    file_id: z.string(),
    file_unique_id: z.string(),
    file_name: z.string().optional(),
    mime_type: z.string().optional(),
    file_size: z.number().optional(),
  }).optional(),
  media_group_id: z.string().optional(),
});

export const TelegramCallbackQuerySchema = z.object({
  id: z.string(),
  from: TelegramUserSchema,
  message: TelegramMessageSchema.optional(),
  data: z.string().optional(),
});

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
  edited_message: TelegramMessageSchema.optional(),
  callback_query: TelegramCallbackQuerySchema.optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export const ParsedExpenseItemSchema = z.object({
  name: z.string(),
  name_normalized_en: z.string(),
  amount: z.number().positive(),
  currency: CurrencySchema.default("PLN"),
  date: z.string().nullable().optional(),
});
export type ParsedExpenseItem = z.infer<typeof ParsedExpenseItemSchema>;

export const ParsedExpensesSchema = z.object({
  expenses: z.array(ParsedExpenseItemSchema),
});
export type ParsedExpenses = z.infer<typeof ParsedExpensesSchema>;

export const ParsedReceiptSchema = z.object({
  merchant: z.string().nullable().optional(),
  total: z.number().positive(),
  currency: CurrencySchema.default("PLN"),
  receipt_date: z.string().nullable().optional(),
  items: z.array(ReceiptItemSchema),
});
export type ParsedReceipt = z.infer<typeof ParsedReceiptSchema>;
