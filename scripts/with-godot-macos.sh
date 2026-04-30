#!/usr/bin/env bash
set -euo pipefail

# Helper to run a command with GODOT_BIN set to the Godot.app binary on macOS.
#
# Usage:
#   bash scripts/with-godot-macos.sh npm run godot:export:tictactoe
#
# Optional:
#   GODOT_APP="/Applications/Godot.app" bash scripts/with-godot-macos.sh ...

if [[ "${1:-}" == "" ]]; then
  echo "Usage: scripts/with-godot-macos.sh <command...>"
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: with-godot-macos.sh is for macOS only."
  exit 1
fi

candidate_apps=()
if [[ -n "${GODOT_APP:-}" ]]; then
  candidate_apps+=("$GODOT_APP")
fi
candidate_apps+=(
  "/Applications/Godot.app"
  "/Applications/Godot 4.app"
  "/Applications/Godot_4.app"
  "/Applications/Godot_4.6.2-stable.app"
)

godot_bin=""
for app in "${candidate_apps[@]}"; do
  if [[ -x "$app/Contents/MacOS/Godot" ]]; then
    godot_bin="$app/Contents/MacOS/Godot"
    break
  fi
done

if [[ -z "$godot_bin" ]]; then
  echo "ERROR: Could not find Godot.app executable."
  echo "Tried:"
  for app in "${candidate_apps[@]}"; do
    echo "  - $app/Contents/MacOS/Godot"
  done
  echo ""
  echo "Fix: set GODOT_APP to your Godot .app path, e.g."
  echo "  GODOT_APP=\"/Applications/Godot.app\" bash scripts/with-godot-macos.sh npm run godot:export:tictactoe"
  exit 1
fi

export GODOT_BIN="$godot_bin"
exec "$@"

