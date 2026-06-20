#!/usr/bin/env bash
# scripts/bump_version.sh - one command to cut a new FinApp release.
#
# Keeps every place the version lives in lockstep so a change propagates to all
# users automatically:
#   - webapp/version.json        (published version the app polls for updates)
#   - webapp/app.js APP_VERSION  (version the loaded build reports)
#   - webapp/index.html          (?v= cache-bust on all assets + shown version)
#   - CHANGELOG.md               (prepends a dated entry)
#
# Usage:
#   bash scripts/bump_version.sh <new-version> "<summary line>" ["<more>" ...]
# Example:
#   bash scripts/bump_version.sh 1.4.0 "Новый раздел инвестиций" "Фикс экспорта CSV"

set -eu

NEW="${1:-}"
shift || true
if [ -z "$NEW" ] || [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/bump_version.sh <new-version> \"<summary>\" [\"<more>\" ...]" >&2
  exit 1
fi
if ! printf '%s' "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "[bump] version must be MAJOR.MINOR.PATCH (got: $NEW)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OLD="$(grep -o '"version"[^,]*' webapp/version.json | head -1 | grep -o '[0-9][0-9.]*')"
if [ -z "$OLD" ]; then echo "[bump] could not read current version" >&2; exit 1; fi
TODAY="$(date +%F)"
echo "[bump] $OLD -> $NEW ($TODAY)"

# 1) version.json
cat > webapp/version.json <<JSON
{
  "version": "$NEW",
  "released": "$TODAY"
}
JSON

# 2) app.js APP_VERSION
perl -0pi -e "s/const APP_VERSION = \"[0-9.]+\";/const APP_VERSION = \"$NEW\";/" webapp/app.js

# 3) index.html cache-bust (?v=OLD -> ?v=NEW) and shown version
perl -0pi -e "s/\?v=\Q$OLD\E\b/?v=$NEW/g" webapp/index.html
perl -0pi -e "s/FinBot v\Q$OLD\E\b/FinBot v$NEW/g" webapp/index.html

# 4) CHANGELOG.md - prepend a dated entry under the header. Done in Python so
# arbitrary text (slashes, Cyrillic, quotes) in the summary can't break it.
NEW="$NEW" TODAY="$TODAY" python3 - "$@" <<'PY'
import os, sys, re
new, today = os.environ["NEW"], os.environ["TODAY"]
lines = sys.argv[1:]
entry = f"## v{new} - {today}\n\n" + "".join(f"- {l}\n" for l in lines) + "\n"
p = "CHANGELOG.md"
s = open(p, encoding="utf-8").read()
# Insert right after the intro paragraph (first blank line that precedes a
# "## v" heading), so the newest release sits on top of the history.
m = re.search(r"\n\n(?=## v)", s)
if not m:
    raise SystemExit("[bump] could not find changelog insertion point")
s = s[: m.end()] + entry + s[m.end():]
open(p, "w", encoding="utf-8").write(s)
print(f"[bump] changelog entry for v{new} added")
PY

echo "[bump] done. Review the diff, then commit + push."
