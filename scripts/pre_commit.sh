#!/usr/bin/env bash
# scripts/pre_commit.sh
#
# Запускается перед `git commit` (либо вручную, либо через git hook).
# Прогоняет: fmt, lint, type check, tests, em-dash scan, secret scan.
#
# Usage: bash scripts/pre_commit.sh
# Exit: 0 если всё ок, 1 если что-то нужно поправить

set -u

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

fail=0

echo "[pre-commit] Running deno fmt..."
if ! deno fmt --check 2>&1 | tail -5; then
  echo "[pre-commit] FAIL: deno fmt found unformatted code. Run 'deno task fmt' to fix." >&2
  fail=1
fi

echo "[pre-commit] Running deno lint..."
if ! deno lint 2>&1 | tail -5; then
  echo "[pre-commit] FAIL: deno lint found issues" >&2
  fail=1
fi

echo "[pre-commit] Running deno check..."
if find supabase/functions -name "*.ts" -print0 2>/dev/null | head -c 1 | grep -q .; then
  if ! deno check supabase/functions/**/*.ts 2>&1 | tail -10; then
    echo "[pre-commit] FAIL: deno check found type errors" >&2
    fail=1
  fi
fi

echo "[pre-commit] Running deno test..."
if [ -d tests ] && find tests -name "*.test.ts" -print0 2>/dev/null | head -c 1 | grep -q .; then
  if ! deno task test 2>&1 | tail -15; then
    echo "[pre-commit] FAIL: tests failing" >&2
    fail=1
  fi
fi

echo "[pre-commit] Scanning for em-dashes in staged files..."
em_dash_count=0
while IFS= read -r staged_file; do
  [ -z "$staged_file" ] && continue
  [ ! -f "$staged_file" ] && continue
  case "$staged_file" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.heic|*.ogg|*.mp3|*.wav|*.pdf|*.zip|*.tar|*.gz|*.tgz)
      continue;;
  esac
  cnt=$(grep -c $'\xe2\x80\x94' "$staged_file" 2>/dev/null)
  cnt=${cnt:-0}
  # Guard: grep -c may emit empty when file unreadable
  if [ "$cnt" -gt 0 ] 2>/dev/null; then
    echo "[pre-commit] em-dash in $staged_file: $cnt" >&2
    em_dash_count=$((em_dash_count + cnt))
  fi
done < <(git diff --cached --name-only --diff-filter=AM)

if [ "$em_dash_count" -gt 0 ]; then
  echo "[pre-commit] FAIL: $em_dash_count em-dash characters in staged files" >&2
  fail=1
fi

echo "[pre-commit] Scanning for secrets in staged files..."
while IFS= read -r staged_file; do
  [ -z "$staged_file" ] && continue
  [ ! -f "$staged_file" ] && continue
  case "$staged_file" in
    *.env|*.env.*|*.png|*.jpg|*.jpeg|*.pdf|*.zip|*.tar|*.gz|*.tgz)
      continue;;
  esac
  if bash scripts/check_secrets.sh "$staged_file" 2>&1 | grep -q CRITICAL; then
    fail=1
  fi
done < <(git diff --cached --name-only --diff-filter=AM)

if [ $fail -ne 0 ]; then
  echo "[pre-commit] FAIL: fix issues before commit"
  exit 1
fi

echo "[pre-commit] OK"
exit 0
