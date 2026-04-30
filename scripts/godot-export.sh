#!/usr/bin/env bash
set -euo pipefail

game="${1:-}"

if [[ -z "$game" ]]; then
  echo "Usage: scripts/godot-export.sh <game>"
  echo "Example: scripts/godot-export.sh tictactoe"
  exit 2
fi

case "$game" in
  tictactoe)
    exec "$(dirname "$0")/godot-export-tictactoe.sh"
    ;;
  *)
    echo "Unknown game: $game"
    exit 2
    ;;
esac

