#!/usr/bin/env bash
set -euo pipefail

# Fast, deterministic GDScript sanity check for the TicTacToe Godot project.
#
# Godot's `--check-only --script` has known edge cases and unreliable exit codes
# across versions. Instead we:
# - start the project headless (which forces script parsing/compilation)
# - immediately quit
# - fail if output contains known parse/load error markers
#
# Usage:
#   scripts/godot-check-tictactoe.sh
#
# Optional env vars:
# - GODOT_BIN: path to `godot` executable (defaults to `godot` on PATH)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/games/tictactoe"

GODOT_BIN="${GODOT_BIN:-godot}"

if ! command -v "$GODOT_BIN" >/dev/null 2>&1; then
  echo "ERROR: Godot executable not found: '$GODOT_BIN'"
  echo "Set GODOT_BIN=/path/to/godot or add it to PATH."
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/project.godot" ]]; then
  echo "ERROR: Godot project not found at: $PROJECT_DIR/project.godot"
  exit 1
fi

echo "Checking Godot scripts:"
echo "- project: $PROJECT_DIR"

LOG_DIR="$ROOT_DIR/tmp/godot-check"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/tictactoe.log"

set +e
out="$("$GODOT_BIN" --headless --path "$PROJECT_DIR" --log-file "$LOG_FILE" --quit 2>&1)"
code="$?"
set -e

echo "$out"
if [[ -f "$LOG_FILE" ]]; then
  echo ""
  echo "---- godot log ($LOG_FILE) ----"
  cat "$LOG_FILE"
  echo "---- end godot log ----"
fi

if [[ "$code" -ne 0 ]]; then
  echo ""
  echo "ERROR: Godot exited with code $code."
  exit "$code"
fi

if [[ "$out" == *"Parse Error"* ]] || [[ "$out" == *"Failed to load script"* ]] || [[ "$out" == *"Failed to load"* ]] || [[ "$out" == *"handle_crash"* ]] || [[ "$out" == *"Program crashed"* ]]; then
  echo ""
  echo "ERROR: Godot script check failed (parse/load errors detected)."
  exit 1
fi

echo ""
echo "OK: Godot scripts compiled cleanly."

