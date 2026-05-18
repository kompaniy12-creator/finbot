#!/usr/bin/env bash
# scripts/install_git_hooks.sh
#
# Устанавливает git pre-commit hook, который дёргает scripts/pre_commit.sh.
# Запускается один раз в M1 после `git init`.

set -eu

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

HOOKS_DIR=".git/hooks"
mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/pre-commit" <<'HOOK'
#!/usr/bin/env bash
# Auto-installed by scripts/install_git_hooks.sh.
exec bash "$(git rev-parse --show-toplevel)/scripts/pre_commit.sh"
HOOK

chmod +x "$HOOKS_DIR/pre-commit"
echo "[install-hooks] OK: .git/hooks/pre-commit installed"
