#!/usr/bin/env bash
# dsh-oc-tui automatic installer for Linux / macOS.
#
# One-command setup of the dsh-oc-tui terminal UI plugin:
#   curl -fsSL https://raw.githubusercontent.com/rayafriandion/dsh-oc-tui/main/install.sh | bash
# or, from a checkout:
#   ./install.sh
set -euo pipefail

PROFILE="${DSH_TUI_PROFILE:-tui}"
REPO="rayafriandion/dsh-oc-tui"
SOURCE="github:${REPO}"
NODE_MIN_MAJOR=22
DSH_PACKAGE="@deepseek-ai/dsh"
LOCAL=0
WITH_LAUNCHER=0

say()  { printf '\033[1;34m[dsh-oc-tui]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dsh-oc-tui]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[dsh-oc-tui]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Automatic installer for the dsh-oc-tui terminal UI plugin.

Options:
  --local           install from this checkout (.) instead of GitHub
  --source <spec>   install a custom source (e.g. dsh-oc-tui for the npm
                    registry, github:you/dsh-oc-tui, or ./dsh-oc-tui-0.1.0.tgz)
  --profile <name>  dsh profile to install into (default: tui, or $DSH_TUI_PROFILE)
  --launcher        also install the dsh-oc-tui launcher command globally
  -h, --help        show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) LOCAL=1 ;;
    --source) SOURCE="${2:?--source needs a value}"; shift ;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift ;;
    --launcher) WITH_LAUNCHER=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [[ "$LOCAL" -eq 1 ]]; then
  SOURCE="."
fi

say "checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed — install Node.js >= ${NODE_MIN_MAJOR} first: https://nodejs.org/"
fi

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || [[ "$node_major" -lt "$NODE_MIN_MAJOR" ]]; then
  die "Node.js >= ${NODE_MIN_MAJOR} is required (found: $(node --version))."
fi

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found — installing it globally via npm..."
  npm install -g pnpm
fi

if command -v dsh >/dev/null 2>&1; then
  DSH_CMD=(dsh)
else
  warn "dsh CLI not found — using npx fallback for this install."
  DSH_CMD=(npx --yes "$DSH_PACKAGE")
fi

say "installing ${SOURCE} into profile '${PROFILE}'..."
"${DSH_CMD[@]}" plugin --profile "$PROFILE" add "$SOURCE"

if [[ "$WITH_LAUNCHER" -eq 1 ]]; then
  say "installing the dsh-oc-tui launcher globally..."
  npm install -g "$SOURCE"
fi

printf '\nInstall complete. Launch it with:\n'
printf '  dsh --profile %s\n' "$PROFILE"
if [[ "$WITH_LAUNCHER" -eq 1 ]]; then
  printf 'or the convenience launcher:\n'
  printf '  dsh-oc-tui\n'
else
  printf 'To add the convenience launcher, rerun with --launcher or run:\n'
  printf '  npm install -g %s\n' "$SOURCE"
fi
