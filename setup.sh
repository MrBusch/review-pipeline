#!/bin/bash
# Creates the "Review Pipeline" macOS desktop launcher app.
# Run once: bash setup.sh

set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Desktop/Review Pipeline.app"
TMP="$(mktemp /tmp/review_pipeline_XXXX.applescript)"

cat > "$TMP" <<APPLESCRIPT
on run
  set projectDir to "$PROJECT"
  set isRunning to false
  try
    set r to do shell script "lsof -ti:3025"
    if r is not "" then set isRunning to true
  end try

  if isRunning then
    set choice to button returned of (display dialog "Review Pipeline is running." buttons {"Stop Server", "Open App"} default button "Open App" with title "Review Pipeline")
    if choice is "Open App" then
      do shell script "bash '" & projectDir & "/start.sh' >> /tmp/review_pipeline.log 2>&1"
    else
      do shell script "bash '" & projectDir & "/stop.sh'"
    end if
  else
    do shell script "bash '" & projectDir & "/start.sh' >> /tmp/review_pipeline.log 2>&1"
  end if
end run
APPLESCRIPT

osacompile -o "$APP" "$TMP"
rm "$TMP"

echo "✓ Review Pipeline.app created on your Desktop."
echo "  Double-click it to start the server and open the app."
