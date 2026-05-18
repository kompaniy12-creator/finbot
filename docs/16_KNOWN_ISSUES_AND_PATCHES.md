# Known Issues and Patches (v1.2)

## Compatibility Fixes

### Issue 1: npm sharp@0.33.5 Incompatible with Supabase Edge Functions

**Problem:** `@supabase/functions-js` uses `sharp` for image optimization, but Edge Functions only
support WebAssembly, not native C++ bindings.

**Solution:** Replace with `@imagemagick/magick-wasm@0.0.30`

**File:** `deno.json`

```json
{
  "imports": {
    "@imagemagick/magick": "npm:@imagemagick/magick-wasm@0.0.30"
  }
}
```

**File:** `src/_shared/image.ts`

```typescript
import { Image } from "@imagemagick/magick";

export async function optimizeImage(base64: string): Promise<string> {
  const image = new Image();
  const blob = Buffer.from(base64, "base64");

  image.read(blob);
  image.resize(1200, 1200); // Max dimensions
  image.quality = 80;

  const optimized = image.write("jpg");
  return Buffer.from(optimized).toString("base64");
}
```

### Issue 2: heic-convert@2.1.0 Also Uses Native Bindings

**Problem:** Same issue as sharp  -  native C++ binding incompatible with Edge Functions.

**Solution:** magick-wasm handles HEIC natively, no separate dependency needed.

**File:** `deno.json`  -  remove heic-convert entirely

### Issue 3: Outdated SDK Versions

**Problem:** Project uses 2-year-old SDK versions:

- `@anthropic-ai/sdk@0.40.0` (current: 0.96.0)
- `groq-sdk@0.10.0` (current: 1.2.0)

**Solution:** Update in `deno.json`

```json
{
  "imports": {
    "@anthropic-ai/sdk": "npm:@anthropic-ai/sdk@0.96.0",
    "groq-sdk": "npm:groq-sdk@1.2.0"
  }
}
```

---

## v1.2-Specific Patches

### Patch A: Auto-Create Supabase Project

See `CLAUDE.local.md` section "Environment Setup (M0.5)".

**When to apply:** During M0.5, before any database migrations

**Bootstrap script location:** Will be generated during M1

### Patch B: Backup Whitelist for Shared Organization

**File:** `scripts/cron-backup.ts`

Only backup FinBot tables, never touch production tables from Twoja Decyzja.

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

// When dumping database:
const dump = await dumpTables(FINBOT_TABLES); // NOT all tables
```

### Patch C: Pre-flight Database Check

**File:** `src/functions/bootstrap.ts` (M1 start)

Before creating any FinBot tables, check for conflicts:

```bash
#!/bin/bash
EXISTING=$(psql $DATABASE_URL -t -c \
  "SELECT string_agg(table_name, ',') FROM information_schema.tables \
   WHERE table_schema='public'")

PRODUCTION_TABLES="payouts,photos,promotions,referrals,transactions,users,withdrawals"
FINBOT_TABLES="family_members,categories,expenses,receipts,expense_audit,exchange_rates,recurring_expenses,anthropic_usage,backup_metadata,cron_jobs,migration_history,settings"

# Check for conflicts
if echo "$EXISTING" | grep -q "payouts"; then
  if echo "$EXISTING" | grep -q "family_members"; then
    echo "⚠️  WARNING: Shared database detected"
    echo "This project contains both production data (Twoja Decyzja) and FinBot tables."
    echo "Proceed only if you understand the risks."
  fi
fi
```

### Patch D: Disable Destructive Operations

**Files affected:**

- `docs/05_TROUBLESHOOTING.md` section A2 (remove `db reset` recommendation)
- `src/functions/migrate.ts` (add guards)

```typescript
// FORBIDDEN operations on shared database:
// ❌ supabase db reset --linked
// ❌ ALTER TABLE ... DROP COLUMN
// ❌ DROP TABLE <non-FinBot table>

// SAFE operations:
// ✅ supabase db push  (forward migrations only)
// ✅ supabase migration new <name>
// ✅ supabase functions deploy
```

---

## Testing the Patches

### 1. Test Image Optimization

```bash
# Run locally:
deno run --allow-all src/_shared/image.ts

# Expected: Optimized JPEG, <500KB
```

### 2. Test Backup Whitelist

```bash
# After backup runs:
gh release view finbot-v0-backup-$(date +%Y%m%d) -R <repo>

# Decrypt and inspect:
age -d -i ~/finbot-backup-key.txt backup.tar.gz | tar -tzf - | grep -E "^payouts|^transactions|^users"

# Expected: NO matches (these tables should NOT be in backup)
```

### 3. Test Shared Database Pre-flight

```bash
# Connect to existing Twoja Decyzja database:
SUPABASE_URL=<your-url> SUPABASE_KEY=<your-key> deno run bootstrap.ts

# Expected: Warning message + confirmation prompt
```

---

## Rollback Instructions

If patches cause issues:

1. **Revert to v1.0 image handler:**
   ```bash
   git revert <commit-hash>
   ```

2. **Restore from backup:**
   ```bash
   age -d -i ~/finbot-backup-key.txt backup-<date>.tar.gz | tar -xzf -
   pg_restore -d $DATABASE_URL dump.sql
   ```

3. **Contact support** with error logs from `supabase functions logs`

---

## Version Compatibility Matrix

| Component                | v1.0   | v1.1   | v1.2   | Status    |
| ------------------------ | ------ | ------ | ------ | --------- |
| deno                     | 1.x    | 2.x    | 2.7+   | ✅        |
| Supabase CLI             | 1.x    | 2.x    | 2.100+ | ✅        |
| @anthropic-ai/sdk        | 0.40   | 0.40   | 0.96   | 🔄 Patch  |
| groq-sdk                 | 0.10   | 0.10   | 1.2    | 🔄 Patch  |
| sharp                    | 0.33.5 | 0.33.5 | ❌     | 🔴 Broken |
| @imagemagick/magick-wasm | N/A    | N/A    | 0.0.30 | 🟢 v1.2+  |
