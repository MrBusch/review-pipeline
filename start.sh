#!/bin/bash

PROJECT="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/review_pipeline_server.log"
PID_FILE="/tmp/review_pipeline.pid"
PORT="${PORT:-3025}"

# macOS notifications when available; plain output elsewhere.
notify() { command -v osascript &>/dev/null && osascript -e "display notification \"$1\" with title \"Review Pipeline\"" || echo "Review Pipeline: $1"; }
open_browser() { command -v open &>/dev/null && open "$1" || { command -v xdg-open &>/dev/null && xdg-open "$1"; } || echo "Open $1"; }

# ── Resolve Node ──────────────────────────────────────────────────────────────
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

if ! command -v node &>/dev/null; then
  notify "Could not find Node.js. Make sure it is installed and try again."
  echo "Could not find Node.js." >&2
  exit 1
fi

# ── Build frontend if missing or source has changed ──────────────────────────
DIST="$PROJECT/client/dist"
NEEDS_BUILD=false
if [ ! -d "$DIST" ]; then
  NEEDS_BUILD=true
elif find "$PROJECT/client/src" "$PROJECT/client/public" "$PROJECT/client/index.html" -newer "$DIST/index.html" -print -quit 2>/dev/null | grep -q .; then
  NEEDS_BUILD=true
fi

# ── Restart if server code changed since it started ──────────────────────────
NEEDS_RESTART=false
if [ -f "$PID_FILE" ] && find "$PROJECT/server" -name '*.js' -not -path '*/node_modules/*' -newer "$PID_FILE" -print -quit 2>/dev/null | grep -q .; then
  NEEDS_RESTART=true
fi

# ── Already running? ──────────────────────────────────────────────────────────
if lsof -ti:$PORT &>/dev/null; then
  if [ "$NEEDS_BUILD" = false ] && [ "$NEEDS_RESTART" = false ]; then
    open_browser "http://localhost:$PORT"
    exit 0
  fi
  kill "$(lsof -ti:$PORT)" 2>/dev/null
  sleep 1
fi

if [ "$NEEDS_BUILD" = true ]; then
  notify "Updating frontend…"
  cd "$PROJECT" && npm run build >> "$LOG" 2>&1
fi

# ── Start server ──────────────────────────────────────────────────────────────
cd "$PROJECT"
nohup node server/index.js >> "$LOG" 2>&1 &
echo $! > "$PID_FILE"

# ── Wait for server (up to 10 s) ─────────────────────────────────────────────
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/api/repos" &>/dev/null; then
    break
  fi
  sleep 0.5
done

open_browser "http://localhost:$PORT"
