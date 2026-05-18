#!/usr/bin/env bash
# scripts/check_dangerous_cmd.sh
#
# Hook PreToolUse: проверяет bash-команду на опасные паттерны.
# Если найден опасный паттерн, печатает предупреждение в stderr и выходит с кодом 2,
# что заставит Claude Code не выполнить команду.
#
# Вызывается автоматически перед каждым Bash-tool через .claude/settings.json.
#
# Usage: bash scripts/check_dangerous_cmd.sh "<command string>"

set -u

cmd="${1:-}"

[ -z "$cmd" ] && exit 0

# Опасные паттерны
declare -a patterns=(
  'rm -rf /(\s|$)'                                # rm -rf /
  'rm -rf /\*'                                    # rm -rf /*
  'rm -rf ~'                                      # rm -rf ~ or ~/*
  'rm -rf \$HOME'                                 # rm -rf $HOME
  'git push --force origin main'                  # force push main
  'git push -f origin main'
  'git reset --hard origin/main'                  # hard reset main
  'supabase projects? delete'                     # delete project
  'gh repo delete'                                # delete repo
  'DROP DATABASE'                                 # SQL drop
  'TRUNCATE.*expenses'                            # truncate live tables
  '\bsudo\b'                                      # sudo (we shouldn't need it)
  ':\(\)\{.*\}:'                                  # fork bomb pattern
  'mkfs\.'                                        # format
  'dd if=.*of=/dev'                               # raw write
)

for p in "${patterns[@]}"; do
  if echo "$cmd" | grep -qE "$p"; then
    echo "[dangerous-cmd-hook] BLOCKED: pattern matches '$p'" >&2
    echo "[dangerous-cmd-hook] Command: $cmd" >&2
    echo "[dangerous-cmd-hook] If this is truly needed, escalate to user per CLAUDE.md section 3." >&2
    exit 2
  fi
done

# Warn-only patterns (don't block, just log)
declare -a warn_patterns=(
  'git push --force'
  'git reset --hard'
  '--no-verify'
)

for p in "${warn_patterns[@]}"; do
  if echo "$cmd" | grep -qE "$p"; then
    echo "[dangerous-cmd-hook] WARNING: '$p' detected, proceeding but verify intent" >&2
  fi
done

exit 0
