#!/usr/bin/env bash
#
# Build the plugin and copy it into one or more Obsidian vaults.
#
# Usage:
#   scripts/deploy-to-vault.sh [--no-build] [--no-hotreload] [VAULT_PATH ...]
#
# VAULT_PATH may point at the vault root (the folder that contains .obsidian)
# or directly at a .obsidian folder. With no paths given, it deploys to every
# sibling ../DKG-testing* vault, plus any in the OBSIDIAN_VAULTS env var
# (colon-separated list of vault roots).
#
# The build step needs Node >= 20 (esbuild + import attributes). If the default
# `node` is older, the script auto-picks the newest nvm-installed Node >= 20.

set -euo pipefail

PLUGIN_ID="origintrail-dkg"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD=1
HOTRELOAD=1
VAULTS=()
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-hotreload) HOTRELOAD=0 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) VAULTS+=("$arg") ;;
  esac
done

# --- pick a Node >= 20 for the build -----------------------------------------
pick_node() {
  if command -v node >/dev/null 2>&1; then
    if [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
      command -v node; return
    fi
  fi
  local nvmdir="${NVM_DIR:-$HOME/.nvm}/versions/node" best="" bestv=""
  if [ -d "$nvmdir" ]; then
    for d in "$nvmdir"/v*; do
      [ -x "$d/bin/node" ] || continue
      local v="${d##*/v}"
      local maj="${v%%.*}"
      [ "$maj" -ge 20 ] || continue
      if [ -z "$bestv" ] || [ "$(printf '%s\n%s\n' "$bestv" "$v" | sort -V | tail -1)" = "$v" ]; then
        best="$d/bin/node"; bestv="$v"
      fi
    done
  fi
  echo "$best"
}

if [ "$BUILD" -eq 1 ]; then
  NODE_BIN="$(pick_node)"
  if [ -z "$NODE_BIN" ]; then
    echo "✗ Need Node >= 20 to build (current: $(node -v 2>/dev/null || echo none))." >&2
    echo "  Install one via nvm, or re-run with --no-build to deploy the existing main.js." >&2
    exit 1
  fi
  echo "▶ Building with $("$NODE_BIN" -v)…"
  # Put the chosen Node first on PATH so the .bin/* shims resolve to it.
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  node_modules/.bin/tsc --noEmit --skipLibCheck
  node esbuild.config.mjs production
  echo "✓ Build OK"
fi

# --- collect target vaults ----------------------------------------------------
if [ "${#VAULTS[@]}" -eq 0 ]; then
  for v in "$ROOT"/../DKG-testing*/; do
    [ -d "$v/.obsidian" ] && VAULTS+=("$v")
  done
  if [ -n "${OBSIDIAN_VAULTS:-}" ]; then
    IFS=':' read -ra _extra <<< "$OBSIDIAN_VAULTS"
    VAULTS+=("${_extra[@]}")
  fi
fi

if [ "${#VAULTS[@]}" -eq 0 ]; then
  echo "✗ No target vaults found. Pass a vault path, or set OBSIDIAN_VAULTS." >&2
  exit 1
fi

# --- copy artifacts -----------------------------------------------------------
ARTIFACTS=(main.js manifest.json styles.css)
for f in "${ARTIFACTS[@]}"; do
  [ -f "$ROOT/$f" ] || { echo "✗ Missing $f — build first (drop --no-build)." >&2; exit 1; }
done

for vault in "${VAULTS[@]}"; do
  # Allow either a vault root or a .obsidian folder.
  case "$vault" in
    */.obsidian|*/.obsidian/) base="${vault%/}" ;;
    *) base="${vault%/}/.obsidian" ;;
  esac
  if [ ! -d "$base" ]; then
    echo "⚠ Skipping '$vault' — no .obsidian folder there." >&2
    continue
  fi
  dest="$base/plugins/$PLUGIN_ID"
  mkdir -p "$dest"
  cp "${ARTIFACTS[@]/#/$ROOT/}" "$dest/"
  [ "$HOTRELOAD" -eq 1 ] && touch "$dest/.hotreload"
  echo "✓ Deployed → $dest"
done

echo "Done. In Obsidian: reload the plugin (or use the Hot Reload community plugin — a .hotreload marker was written)."
