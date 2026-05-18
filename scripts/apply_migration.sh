#!/usr/bin/env bash
# scripts/apply_migration.sh
#
# Apply a SQL migration file to Supabase via Management API query endpoint.
# Used in shared-org mode when we have SUPABASE_ACCESS_TOKEN but no DB password.
#
# Hard safety per CLAUDE.local.md:
#   - REFUSE if the SQL touches blacklist tables (DROP/ALTER/TRUNCATE on
#     payouts/photos/promotions/referrals/transactions/users/withdrawals).
#   - REFUSE on --force/CASCADE without explicit override.
#
# Usage:
#   bash scripts/apply_migration.sh <path-to.sql>
# Env required:
#   SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF (from .env)

set -eu

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "[apply-migration] FAIL: file required and must exist: $FILE" >&2
  exit 1
fi

# Load .env if present (don't fail if missing, we may be in CI)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN not set}"
: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF not set}"

# Blacklist guard: any DROP/ALTER/TRUNCATE on Twoja Decyzja prod tables = abort.
BLACKLIST='payouts|photos|promotions|referrals|transactions|users|withdrawals'
if grep -iE "(drop|alter|truncate|delete from)[[:space:]]+(table[[:space:]]+)?(public\.)?($BLACKLIST)\b" "$FILE" >/dev/null 2>&1; then
  echo "[apply-migration] CRITICAL: $FILE attempts DDL on blacklist table." >&2
  echo "[apply-migration] Blocked. Review the SQL before retrying." >&2
  exit 2
fi

# CASCADE on any DROP is also dangerous in shared DB
if grep -iE 'drop[[:space:]]+(table|schema|function)[^;]*cascade' "$FILE" >/dev/null 2>&1; then
  echo "[apply-migration] CRITICAL: CASCADE drop in $FILE blocked." >&2
  exit 2
fi

echo "[apply-migration] Applying: $FILE"

PAYLOAD=$(jq -Rs '{query: .}' < "$FILE")

RESPONSE=$(curl -sS -X POST \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Detect error: management API returns {"message":"..."} on error,
# returns [...] (array) on success (even empty for DDL).
if echo "$RESPONSE" | jq -e 'type == "object" and has("message")' >/dev/null 2>&1; then
  echo "[apply-migration] FAIL: $FILE" >&2
  echo "$RESPONSE" | jq -r '.message' >&2
  exit 1
fi

echo "[apply-migration] OK: $FILE"
exit 0
