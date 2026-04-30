#!/usr/bin/env bash
set -euo pipefail

# Exports the Godot HTML5 build for TicTacToe into:
#   platform/web/public/godot/tictactoe/
#
# Requirements:
# - Godot 4.6.x installed (CLI executable available)
# - Matching export templates installed for that Godot version
# - `games/tictactoe/export_presets.cfg` contains a preset named "Web"
#
# Usage:
#   scripts/godot-export-tictactoe.sh
#
# Optional env vars:
# - GODOT_BIN: path to `godot` executable (defaults to `godot` on PATH)
# - GODOT_EXPORT_PRESET: preset name (defaults to "Web")

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/games/tictactoe"
OUT_DIR="$ROOT_DIR/platform/web/public/godot/tictactoe"

GODOT_BIN="${GODOT_BIN:-godot}"
PRESET="${GODOT_EXPORT_PRESET:-Web}"

if ! command -v "$GODOT_BIN" >/dev/null 2>&1; then
  echo "ERROR: Godot executable not found: '$GODOT_BIN'"
  echo "Set GODOT_BIN=/path/to/godot or add it to PATH."
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/project.godot" ]]; then
  echo "ERROR: Godot project not found at: $PROJECT_DIR/project.godot"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/export_presets.cfg" ]]; then
  echo "ERROR: Missing export presets at: $PROJECT_DIR/export_presets.cfg"
  echo ""
  echo "Create it once in the Godot editor:"
  echo "- Project -> Export -> Add... -> Web"
  echo "- Name the preset exactly: $PRESET"
  echo "- Save, then re-run this script."
  exit 1
fi

mkdir -p "$OUT_DIR"

# Godot writes multiple sibling files next to the output html.
OUT_HTML="$OUT_DIR/index.html"

echo "Exporting Godot project:"
echo "- project: $PROJECT_DIR"
echo "- preset:  $PRESET"
echo "- output:  $OUT_HTML"

# Use --headless for CI-friendly export.
"$GODOT_BIN" --headless --path "$PROJECT_DIR" --export-release "$PRESET" "$OUT_HTML"

if [[ ! -f "$OUT_HTML" ]]; then
  echo "ERROR: Export completed but index.html not found at: $OUT_HTML"
  exit 1
fi

echo "OK: exported to $OUT_DIR"

