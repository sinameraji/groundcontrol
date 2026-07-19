#!/usr/bin/env bash
#
# Install the groundcontrol launchd agents (orchestrator, hotcell daemon,
# weekly janitor) for the current user. Idempotent — safe to re-run after a
# git pull or when node/hotcell paths change. See ops/setup.md for the full
# runbook.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── prerequisites ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH (brew install node)" >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
HOTCELL_BIN="$(command -v hotcell || true)"

# Colima puts the Docker socket in $HOME, not /var/run — the hotcell daemon
# needs DOCKER_HOST pointed there or it fails with "connect ENOENT
# /var/run/docker.sock".
DOCKER_SOCK="$HOME/.colima/default/docker.sock"
EXTRA_ENV=""
if [ -S "$DOCKER_SOCK" ] && [ ! -S /var/run/docker.sock ]; then
  EXTRA_ENV="<key>DOCKER_HOST</key><string>unix://$DOCKER_SOCK</string>"
  echo "colima detected — baking DOCKER_HOST into the hotcell daemon plist"
fi

if [ ! -f "$GC_DIR/dist/index.js" ]; then
  echo "dist/index.js missing — building..."
  (cd "$GC_DIR" && npm run build)
fi

LOG_DIR="$HOME/Library/Logs/groundcontrol"
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR" "$AGENTS_DIR"

GUI_DOMAIN="gui/$(id -u)"

# ── render + (re)load one plist ────────────────────────────────────────────
install_plist() {
  local src="$1"
  local label
  label="$(basename "$src" .plist)"
  local dst="$AGENTS_DIR/$label.plist"

  sed \
    -e "s|__GC_DIR__|$GC_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__HOTCELL_BIN__|$HOTCELL_BIN|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|<!-- __EXTRA_ENV__.*-->|$EXTRA_ENV|g" \
    "$src" > "$dst"
  plutil -lint -s "$dst"

  # Unload any previous copy first so bootstrap succeeds on re-runs.
  launchctl bootout "$GUI_DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$GUI_DOMAIN" "$dst"
  echo "installed  $label  ->  $dst"
}

install_plist "$SCRIPT_DIR/com.groundcontrol.orchestrator.plist"
install_plist "$SCRIPT_DIR/com.groundcontrol.janitor.plist"

if [ -n "$HOTCELL_BIN" ]; then
  install_plist "$SCRIPT_DIR/com.groundcontrol.hotcelld.plist"
else
  echo "warning: hotcell not found on PATH — skipping com.groundcontrol.hotcelld" >&2
  echo "         (npm i -g hotcell, then re-run this script)" >&2
fi

# ── status ─────────────────────────────────────────────────────────────────
echo
echo "status:"
for label in com.groundcontrol.orchestrator com.groundcontrol.hotcelld com.groundcontrol.janitor; do
  if launchctl print "$GUI_DOMAIN/$label" >/dev/null 2>&1; then
    echo "  $label  loaded"
  else
    echo "  $label  not loaded"
  fi
done

cat <<EOF

logs: $LOG_DIR/
  tail -f $LOG_DIR/orchestrator.log

Not done by this script — run yourself if you haven't yet:
  sudo pmset -c sleep 0                        # never sleep on AC power
  sudo pmset -c disksleep 0                    # keep the artifact drive awake
  tailscale serve --bg http://127.0.0.1:4760   # tailnet-only artifact links
  hotcell keys add openrouter                  # provider key into the keychain
EOF
