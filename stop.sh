#!/bin/bash

PID_FILE="/tmp/review_pipeline.pid"
PORT="${PORT:-3025}"

# macOS notifications when available; plain output elsewhere.
notify() { command -v osascript &>/dev/null && osascript -e "display notification \"$1\" with title \"Review Pipeline\"" || echo "Review Pipeline: $1"; }

PID=$(lsof -ti:$PORT 2>/dev/null)
rm -f "$PID_FILE"
if [ -n "$PID" ]; then
  kill $PID
  notify "Server stopped."
else
  notify "Server was not running."
fi
