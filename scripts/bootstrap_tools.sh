#!/usr/bin/env bash
# scripts/bootstrap_tools.sh
#
# Проверяет наличие нужных тулов и устанавливает отсутствующие
# через подходящий пакетный менеджер. Запускается один раз в M1.
#
# Usage: bash scripts/bootstrap_tools.sh

set -u

is_macos() { [[ "$OSTYPE" == "darwin"* ]]; }
is_linux() { [[ "$OSTYPE" == "linux-gnu"* ]]; }

have() { command -v "$1" >/dev/null 2>&1; }

install_brew() {
  pkg="$1"
  echo "[bootstrap] Installing $pkg via brew..."
  brew install "$pkg" || { echo "[bootstrap] brew install $pkg failed" >&2; return 1; }
}

install_apt() {
  pkg="$1"
  echo "[bootstrap] Installing $pkg via apt..."
  sudo apt-get update -qq && sudo apt-get install -y -qq "$pkg" || { echo "[bootstrap] apt install $pkg failed" >&2; return 1; }
}

install_deno() {
  if have deno; then return 0; fi
  echo "[bootstrap] Installing Deno..."
  curl -fsSL https://deno.land/install.sh | sh
  export PATH="$HOME/.deno/bin:$PATH"
  hash -r
}

install_supabase() {
  if have supabase; then return 0; fi
  echo "[bootstrap] Installing Supabase CLI..."
  if is_macos; then
    brew install supabase/tap/supabase
  elif is_linux; then
    # Use the official tarball install
    SB_VERSION=$(curl -fsS https://api.github.com/repos/supabase/cli/releases/latest | grep tag_name | head -1 | cut -d'"' -f4 | sed 's/^v//')
    ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=amd64
    curl -fsSL "https://github.com/supabase/cli/releases/download/v${SB_VERSION}/supabase_${SB_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/sb.tar.gz
    mkdir -p "$HOME/.local/bin"
    tar -xzf /tmp/sb.tar.gz -C "$HOME/.local/bin" supabase
    chmod +x "$HOME/.local/bin/supabase"
    export PATH="$HOME/.local/bin:$PATH"
  fi
}

install_gh() {
  if have gh; then return 0; fi
  echo "[bootstrap] Installing GitHub CLI..."
  if is_macos; then
    brew install gh
  elif is_linux; then
    (type -p wget >/dev/null || sudo apt-get install -y -qq wget) \
      && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
      && sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
      && sudo apt-get update -qq \
      && sudo apt-get install -y -qq gh
  fi
}

install_age() {
  if have age && have age-keygen; then return 0; fi
  echo "[bootstrap] Installing age..."
  if is_macos; then
    brew install age
  elif is_linux; then
    sudo apt-get install -y -qq age || {
      # Fallback to direct download
      AGE_VERSION="1.2.0"
      ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=amd64
      curl -fsSL "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-${ARCH}.tar.gz" -o /tmp/age.tar.gz
      mkdir -p "$HOME/.local/bin"
      tar -xzf /tmp/age.tar.gz -C /tmp
      mv /tmp/age/age /tmp/age/age-keygen "$HOME/.local/bin/"
      chmod +x "$HOME/.local/bin/age" "$HOME/.local/bin/age-keygen"
      export PATH="$HOME/.local/bin:$PATH"
    }
  fi
}

# Required: git, curl, jq (usually present)
for t in git curl jq; do
  if ! have "$t"; then
    if is_macos; then install_brew "$t"; elif is_linux; then install_apt "$t"; fi
  fi
done

install_deno
install_supabase
install_gh
install_age

# Sanity check
fail=0
for t in deno supabase gh git curl jq age age-keygen; do
  if ! have "$t"; then
    echo "[bootstrap] MISSING: $t" >&2
    fail=1
  else
    echo "[bootstrap] OK: $t ($($t --version 2>&1 | head -1))"
  fi
done

if [ $fail -ne 0 ]; then
  echo "[bootstrap] Some tools missing, install manually then re-run" >&2
  exit 1
fi

echo "[bootstrap] All tools ready"
exit 0
