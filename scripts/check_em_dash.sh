#!/usr/bin/env bash
# scripts/check_em_dash.sh
#
# Hook PostToolUse: проверяет файл на наличие em-dash (U+2014).
# Если найден, печатает предупреждение в stderr и заменяет em-dash на " - ".
# Вызывается автоматически после Write/Edit через .claude/settings.json.
#
# Usage: bash scripts/check_em_dash.sh <file_path>

set -u

file="${1:-}"

# Pass-through if no file or not a regular file we care about
[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

# Skip binary files and node_modules
case "$file" in
  *.png|*.jpg|*.jpeg|*.gif|*.webp|*.heic|*.ogg|*.mp3|*.wav|*.pdf|*.zip|*.tar|*.gz|*.tgz)
    exit 0;;
  */node_modules/*|*/.git/*|*/cov/*|*/.supabase/*)
    exit 0;;
esac

# Count em-dashes (grep -c exits 1 if no match, so guard arithmetic)
count=$(grep -c $'\xe2\x80\x94' "$file" 2>/dev/null)
count=${count:-0}

if [ "$count" -gt 0 ] 2>/dev/null; then
  echo "[em-dash-hook] WARNING: $count em-dash found in $file, auto-replacing with ' - '" >&2
  # Replace em-dash with " - " in place (BSD/GNU compatible)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' $'s/\xe2\x80\x94/ - /g' "$file"
  else
    sed -i $'s/\xe2\x80\x94/ - /g' "$file"
  fi
fi

exit 0
