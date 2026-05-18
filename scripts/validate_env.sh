#!/usr/bin/env bash
# scripts/validate_env.sh
#
# Проверяет, что все обязательные переменные окружения существуют в .env
# и валидны (где это можно проверить через API).
#
# Usage: bash scripts/validate_env.sh
# Exit: 0 если всё ок, 1 если что-то невалидно

set -u

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[validate-env] FAIL: $ENV_FILE not found" >&2
  exit 1
fi

# Load .env
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

declare -a required=(
  TELEGRAM_BOT_TOKEN
  TELEGRAM_ADMIN_TELEGRAM_ID
  ANTHROPIC_API_KEY
  CLAUDE_MODEL_FAST
  CLAUDE_MODEL_VISION
  ANTHROPIC_DAILY_BUDGET_USD
  ANTHROPIC_DAILY_BUDGET_USD_PER_USER
  GROQ_API_KEY
  GROQ_MODEL
  WHISPER_LANGUAGES_WHITELIST
  WHISPER_MAX_VOICE_DURATION_SEC
  IMAGE_MAX_DIMENSION
  IMAGE_JPEG_QUALITY
  PHOTO_RETENTION_DAYS
  DEFAULT_CURRENCY
  DEFAULT_TIMEZONE
  HIGH_AMOUNT_THRESHOLD_PLN
  CONFIRMATION_TIMEOUT_SEC
  UNDO_WINDOW_MINUTES
  CRON_SECRET
  GITHUB_TOKEN
  GITHUB_REPO
  BACKUP_ENCRYPTION_KEY
)

declare -a missing=()

for var in "${required[@]}"; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "[validate-env] FAIL: missing variables:" >&2
  for m in "${missing[@]}"; do
    echo "  - $m" >&2
  done
  exit 1
fi

# API validations (lightweight)
fail=0

# Telegram
TG_RESP=$(curl -fsS --max-time 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || echo "")
if ! echo "$TG_RESP" | grep -q '"ok":true'; then
  echo "[validate-env] FAIL: TELEGRAM_BOT_TOKEN invalid (getMe response: $TG_RESP)" >&2
  fail=1
fi

# Anthropic
ANT_RESP=$(curl -fsS --max-time 10 "https://api.anthropic.com/v1/models" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" 2>/dev/null || echo "")
if ! echo "$ANT_RESP" | grep -q '"data"'; then
  echo "[validate-env] FAIL: ANTHROPIC_API_KEY invalid" >&2
  fail=1
fi

# Groq
GROQ_RESP=$(curl -fsS --max-time 10 "https://api.groq.com/openai/v1/models" \
  -H "Authorization: Bearer $GROQ_API_KEY" 2>/dev/null || echo "")
if ! echo "$GROQ_RESP" | grep -q '"data"'; then
  echo "[validate-env] FAIL: GROQ_API_KEY invalid" >&2
  fail=1
fi

# GitHub
GH_RESP=$(curl -fsS --max-time 10 "https://api.github.com/user" \
  -H "Authorization: Bearer $GITHUB_TOKEN" 2>/dev/null || echo "")
if ! echo "$GH_RESP" | grep -q '"login"'; then
  echo "[validate-env] FAIL: GITHUB_TOKEN invalid" >&2
  fail=1
fi

# age public key format
if ! echo "$BACKUP_ENCRYPTION_KEY" | grep -qE '^age1[a-z0-9]+$'; then
  echo "[validate-env] FAIL: BACKUP_ENCRYPTION_KEY does not match age public key format" >&2
  fail=1
fi

# CRON_SECRET non-empty and long enough
if [ "${#CRON_SECRET}" -lt 32 ]; then
  echo "[validate-env] FAIL: CRON_SECRET too short (must be >= 32 chars)" >&2
  fail=1
fi

# GITHUB_REPO format owner/repo
if ! echo "$GITHUB_REPO" | grep -qE '^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$'; then
  echo "[validate-env] FAIL: GITHUB_REPO must be in owner/repo format" >&2
  fail=1
fi

if [ $fail -ne 0 ]; then
  echo "[validate-env] One or more validations failed" >&2
  exit 1
fi

echo "[validate-env] OK: all ${#required[@]} variables present and validated"
exit 0
