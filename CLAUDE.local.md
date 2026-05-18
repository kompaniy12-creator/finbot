# FinBot v1.2 - Auto-Create Supabase + Shared Org Mode

## Critical Overrides for Auto-Bootstrap

This document overrides `docs/00_AUTONOMY.md` for v1.2 automatic setup mode.

### Environment Setup (M0.5 - NEW)

**Instead of using pre-existing project_ref and db_password**, you will:

1. **Use Management API to create Supabase project automatically**
   - API endpoint: `POST https://api.supabase.com/v1/projects`
   - Required parameter: `SUPABASE_ACCESS_TOKEN` (sbp_*)
   - Parameters to send:
     ```json
     {
       "name": "finbot",
       "organization_id": "<extracted from existing org>",
       "db_pass": "<generate random 24+ chars, store securely>",
       "region": "eu-central-1",
       "plan": "free"
     }
     ```
   - Wait 3 minutes for project initialization
   - Extract `project_ref` from response and store in .env
   - Confirm project is in RUNNING state

2. **Generate `age` keypair locally** (instead of asking user)
   - Execute: `age-keygen -o /tmp/age-key.txt`
   - Read private key from file
   - **Display private key to user ONE TIME ONLY** with message:
     ```
     ⚠️ BACKUP ENCRYPTION KEY (SAVE THIS SECURELY TO 1PASSWORD NOW):
     AGE-SECRET-KEY-1...
     Do NOT close this session until you confirm you've saved it.
     Type "age-key-saved" when done.
     ```
   - Wait for user confirmation before proceeding to M1
   - Extract public key and write to .env as `BACKUP_ENCRYPTION_KEY`

3. **Generate `CRON_SECRET`**
   - Execute: `openssl rand -hex 32`
   - Write to .env as `CRON_SECRET`

### Bootstrap Key List (Reduced from 12 to 7)

User must provide **exactly 7 values** in one message. Accept any format (list, JSON,
comma-separated):

```
TELEGRAM_BOT_TOKEN:       1234567890:ABC...
TELEGRAM_ADMIN_TELEGRAM_ID: 123456789
ANTHROPIC_API_KEY:        sk-ant-api03-...
GROQ_API_KEY:             gsk_...
SUPABASE_ACCESS_TOKEN:    sbp_...
GITHUB_USERNAME:          username
GITHUB_TOKEN:             ghp_...
```

**Everything else is generated automatically:**

- SUPABASE_PROJECT_REF (from API response)
- SUPABASE_DB_PASSWORD (generated + shown once)
- BACKUP_ENCRYPTION_KEY (generated + shown once)
- CRON_SECRET (generated)
- GITHUB_REPO_NAME (defaults to "finbot")
- SUPABASE_ORG (inferred from token, defaults to "Twoja Decyzja")
- SUPABASE_REGION (defaults to "eu-central-1")

### Shared Organization Safety (M1 - Pre-flight Check)

Before any migrations, execute pre-flight check:

```bash
psql $DATABASE_URL -c "
  SELECT table_name FROM information_schema.tables 
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
" | tee /tmp/existing_tables.txt
```

**Whitelist of FinBot tables (must-create, can-delete in M2):**

```
family_members
categories
expenses
receipts
expense_audit
exchange_rates
recurring_expenses
anthropic_usage
backup_metadata
cron_jobs
migration_history
settings
```

**Blacklist of existing tables (MUST NOT DELETE):**

```
payouts
photos
promotions
referrals
transactions
users
withdrawals
```

**If any blacklist table exists + any whitelist table exists:**

- Log: "WARNING: Shared database detected (Twoja Decyzja + FinBot tables)"
- Confirm with user: "This project has existing data. Continue at your own risk? (yes/no)"
- If no → STOP and ask user to create separate Supabase project

**If only blacklist tables exist (no FinBot tables yet):**

- Log: "Database is clean, proceeding with FinBot setup"
- Proceed normally to M1

**If only whitelist tables exist or database is empty:**

- Log: "Creating fresh FinBot database"
- Proceed normally to M1

### Backup Whitelist (cron-backup.ts override)

Modify `scripts/cron-backup.ts` to only dump FinBot tables, never production tables:

```typescript
const FINBOT_TABLES = [
  "family_members",
  "categories",
  "expenses",
  "receipts",
  "expense_audit",
  "exchange_rates",
  "recurring_expenses",
  "anthropic_usage",
  "backup_metadata",
  "cron_jobs",
  "migration_history",
  "settings",
];

// In dump function:
const tables = await client
  .from("information_schema.tables")
  .select("table_name")
  .eq("table_schema", "public")
  .in("table_name", FINBOT_TABLES) // ← ONLY FinBot tables
  .then((r) => r.data.map((t) => t.table_name));
```

### Destructive Operation Restrictions (M2+ safety)

**HARD PROHIBITIONS:**

1. **`supabase db reset --linked`** is forbidden in all contexts
   - Log every reset-like operation: `supabase db push --force`, `ALTER TABLE ... DROP`, etc.
   - If encountered during error recovery, STOP and ask user

2. **`DROP TABLE`, `DROP SCHEMA` on non-FinBot tables**
   - Validate all DDL: before executing migrations, check if table_name NOT IN `FINBOT_TABLES`
   - If violation detected → STOP with error message

3. **`supabase db push --force`** only if absolutely necessary
   - Require explicit user confirmation for any --force flag
   - Log: "User confirmed force push at <timestamp>"

### Resume Mode (STATE.md Update)

When resuming from saved state, also load:

- `SUPABASE_PROJECT_REF` from current env (don't re-query API)
- `BACKUP_ENCRYPTION_KEY` from env (don't regenerate  -  if user lost private key, backups
  unrecoverable)
- `CRON_SECRET` from env (don't change  -  would break deployed cron jobs)

---

## Implementation Notes

- All 3 generated values (db_password, age-key private, cron_secret) shown **one time each**  -  if
  user doesn't save them, recovery is difficult/impossible
- Age key recovery: if user lost private key, `~/.config/age/` on their machine + 1Password recovery
  codes are only options
- Project creation via API is idempotent: if request repeats, Supabase returns existing project_ref
  (safe)
- If Management API fails (rate limit, network), catch error and suggest manual creation via UI

---

## Legacy Compatibility

This v1.2 override is **backwards compatible** with v1.0/v1.1 workflows:

- If SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD provided manually → use them directly (skip M0.5)
- If only SUPABASE_ACCESS_TOKEN provided → auto-create (v1.2 mode)

Choose behavior based on user preference before M1.
