#!/bin/bash
# Removes peon-ping-editor and PeonBar. peon-ping itself, its config and your sound edits are left alone.
set -uo pipefail

EDITOR_HOME="${PEON_EDITOR_HOME:-$HOME/.peon-editor}"
LAUNCHER="$HOME/.local/bin/peon-editor"
APP="$HOME/Applications/PeonBar.app"
AGENT="$HOME/Library/LaunchAgents/com.peonping.peonbar.plist"

if [ -f "$AGENT" ]; then
  launchctl bootout "gui/$(id -u)/com.peonping.peonbar" 2>/dev/null || launchctl unload "$AGENT" 2>/dev/null
  rm -f "$AGENT"
fi
pkill -x PeonBar 2>/dev/null
pkill -f "$EDITOR_HOME/app/bin/peon-editor.js" 2>/dev/null
rm -rf "$APP"
defaults delete com.peonping.peonbar >/dev/null 2>&1
# Only remove the launcher if the installer wrote it
grep -q "peon-ping-editor launcher" "$LAUNCHER" 2>/dev/null && rm -f "$LAUNCHER"
rm -rf "$EDITOR_HOME"

echo "peon-ping-editor removed."
echo "Kept: peon-ping, its config.json, and moved/reordered sounds (~/.claude/hooks/peon-editor-moves.json)."
