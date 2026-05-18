#!/usr/bin/env bash
# scripts/check_secrets.sh
#
# Hook PostToolUse: проверяет файл на наличие захардкоженных секретов.
# Если найден, печатает CRITICAL предупреждение и (в строгом режиме) удаляет файл.
# Вызывается автоматически после Write/Edit через .claude/settings.json.
#
# Usage: bash scripts/check_secrets.sh <file_path>

set -u

file="${1:-}"

# Pass-through if no file
[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

# Skip binary files, .env (managed separately), docs/prompts/scripts (placeholders),
# and the secret scanner itself (contains regex patterns).
case "$file" in
  *.png|*.jpg|*.jpeg|*.gif|*.webp|*.heic|*.ogg|*.mp3|*.wav|*.pdf|*.zip|*.tar|*.gz|*.tgz)
    exit 0;;
  *.env|*.env.*|.env|.env.*|*/.env|*/.env.*|*/node_modules/*|*/.git/*|*/cov/*)
    exit 0;;
  SPEC.md|CLAUDE.md|CLAUDE.local.md|README.md|QUICKSTART.md|BACKLOG.md)
    exit 0;;
  */SPEC.md|*/CLAUDE.md|*/CLAUDE.local.md|*/README.md|*/QUICKSTART.md|*/BACKLOG.md)
    exit 0;;
  docs/*|prompts/*|.claude/*)
    exit 0;;
  */docs/*|*/prompts/*|*/.claude/*)
    exit 0;;
  scripts/check_secrets.sh|*/scripts/check_secrets.sh)
    # Self: contains the regex patterns we look for.
    exit 0;;
esac

found=0

# Anthropic API key
if grep -qE 'sk-ant-[a-zA-Z0-9_-]{40,}' "$file"; then
  echo "[secret-hook] CRITICAL: Anthropic API key in $file" >&2
  found=1
fi

# Groq key
if grep -qE 'gsk_[a-zA-Z0-9]{40,}' "$file"; then
  echo "[secret-hook] CRITICAL: Groq API key in $file" >&2
  found=1
fi

# GitHub PAT
if grep -qE 'gh[ps]_[a-zA-Z0-9]{30,}' "$file"; then
  echo "[secret-hook] CRITICAL: GitHub token in $file" >&2
  found=1
fi

# Supabase access token
if grep -qE 'sbp_[a-zA-Z0-9]{40,}' "$file"; then
  echo "[secret-hook] CRITICAL: Supabase access token in $file" >&2
  found=1
fi

# Telegram bot token
if grep -qE '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' "$file" | grep -v '1234567890:ABCdef'; then
  echo "[secret-hook] CRITICAL: Telegram bot token in $file" >&2
  found=1
fi

# age private key
if grep -q 'AGE-SECRET-KEY-' "$file"; then
  echo "[secret-hook] CRITICAL: age private key in $file" >&2
  found=1
fi

# postgres password in URL
if grep -qE 'postgresql://postgres:[^@:]+@[^/]+\.supabase\.co' "$file"; then
  echo "[secret-hook] CRITICAL: Postgres URL with password in $file" >&2
  found=1
fi

if [ $found -eq 1 ]; then
  echo "[secret-hook] Run: git diff $file" >&2
  echo "[secret-hook] Action required: REMOVE the secret, use Deno.env.get() instead, then continue." >&2
  exit 1  # non-zero alerts Claude Code something is wrong (but Claude Code reads stderr too)
fi

exit 0
