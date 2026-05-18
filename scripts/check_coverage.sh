#!/usr/bin/env bash
# scripts/check_coverage.sh
#
# Прогоняет тесты с coverage и проверяет пороги.
# Usage: bash scripts/check_coverage.sh
# Exit: 0 если все пороги соблюдены, 1 если нет

set -u

THRESHOLD_FUNCTIONS=80
THRESHOLD_SHARED=90

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

rm -rf cov

echo "[coverage] Running tests with coverage..."
if ! deno test --allow-all --coverage=cov tests/ > /tmp/test-output.txt 2>&1; then
  echo "[coverage] FAIL: tests not green, fix tests first" >&2
  tail -20 /tmp/test-output.txt >&2
  exit 1
fi

# Сначала функции (кроме _shared)
funcs_pct=$(deno coverage cov --include="supabase/functions/" --exclude="supabase/functions/_shared/" 2>&1 \
  | grep -E '^All files' | head -1 | awk '{print $NF}' | tr -d '%' || echo 0)

# _shared
shared_pct=$(deno coverage cov --include="supabase/functions/_shared/" 2>&1 \
  | grep -E '^All files' | head -1 | awk '{print $NF}' | tr -d '%' || echo 0)

echo "[coverage] supabase/functions/ (non-shared): ${funcs_pct}% (threshold: ${THRESHOLD_FUNCTIONS}%)"
echo "[coverage] supabase/functions/_shared/:     ${shared_pct}% (threshold: ${THRESHOLD_SHARED}%)"

fail=0

awk -v c="$funcs_pct" -v t="$THRESHOLD_FUNCTIONS" 'BEGIN{exit !(c+0 >= t+0)}' || {
  echo "[coverage] FAIL: functions coverage ${funcs_pct}% below ${THRESHOLD_FUNCTIONS}%" >&2
  fail=1
}

awk -v c="$shared_pct" -v t="$THRESHOLD_SHARED" 'BEGIN{exit !(c+0 >= t+0)}' || {
  echo "[coverage] FAIL: _shared coverage ${shared_pct}% below ${THRESHOLD_SHARED}%" >&2
  fail=1
}

if [ $fail -ne 0 ]; then
  echo "[coverage] Detailed uncovered lines (top 20):"
  deno coverage cov --detailed --include="supabase/functions/" 2>&1 | head -40
  exit 1
fi

echo "[coverage] OK: all thresholds met"
exit 0
