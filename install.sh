#!/bin/bash
# peon-ping-editor installer: the editor UI plus, on macOS, the PeonBar menu-bar app (starts at login).
#
#   curl -fsSL https://raw.githubusercontent.com/Ferosima/peon-ping-editor/main/install.sh | bash
#
# Re-run it any time to update. Environment overrides:
#   PEON_EDITOR_REF   branch or tag to install (default: main)
#   PEON_EDITOR_HOME  where the app lives (default: ~/.peon-editor)
#   PEON_DIR          peon-ping install dir (default: ~/.claude/hooks/peon-ping)
set -euo pipefail

REPO="${PEON_EDITOR_REPO:-Ferosima/peon-ping-editor}"
REF="${PEON_EDITOR_REF:-main}"
EDITOR_HOME="${PEON_EDITOR_HOME:-$HOME/.peon-editor}"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/peon-editor"
APP="$HOME/Applications/PeonBar.app"
AGENT="$HOME/Library/LaunchAgents/com.peonping.peonbar.plist"
PEON_DIR="${PEON_DIR:-${CLAUDE_PEON_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/peon-ping}}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. peon-ping must already be there ---------------------------------------
if [ ! -f "$PEON_DIR/peon.sh" ]; then
  die "peon-ping is not installed (looked in $PEON_DIR).
  Install it first, then run this installer again:

    curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash

  or with Homebrew:  brew install PeonPing/tap/peon-ping && peon-ping-setup"
fi

# --- 2. Node.js 18+ ----------------------------------------------------------
# Same search as the launcher below, so whatever works here works for PeonBar too.
find_node() {
  local c
  for c in "${PEON_EDITOR_NODE:-}" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node \
           "$HOME/.volta/bin/node" $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V -r) \
           $(ls -d "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V -r); do
    # process.exit needs a number: Node 20+ throws on a boolean
    [ -n "$c" ] && [ -x "$c" ] && "$c" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null && { echo "$c"; return 0; }
  done
  return 1
}
NODE="$(find_node)" || die "Node.js 18 or newer is required.
  Install it (for example: brew install node) and run this installer again."
say "Using Node $("$NODE" -v) ($NODE)"

# --- 3. Get the app -----------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SRC=""
# Running from a checkout (bash install.sh)? Install that instead of downloading.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$HERE/bin/peon-editor.js" ] && SRC="$HERE"
fi
if [ -z "$SRC" ]; then
  say "Downloading $REPO@$REF"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMP" || die "Download failed"
  SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -f "$SRC/bin/peon-editor.js" ] || die "Unexpected archive layout"
fi

# A running editor keeps the old code in memory; stop it so the next launch picks up this version
pkill -f "$EDITOR_HOME/app/bin/peon-editor.js" 2>/dev/null || true

mkdir -p "$EDITOR_HOME"
rm -rf "$EDITOR_HOME/app.new"
mkdir -p "$EDITOR_HOME/app.new"
for item in bin src public menubar package.json LICENSE README.md install.sh uninstall.sh; do
  [ -e "$SRC/$item" ] && cp -R "$SRC/$item" "$EDITOR_HOME/app.new/"
done
rm -rf "$EDITOR_HOME/app"
mv "$EDITOR_HOME/app.new" "$EDITOR_HOME/app"
VERSION="$("$NODE" -p "require('$EDITOR_HOME/app/package.json').version")"
say "Installed peon-ping-editor $VERSION to $EDITOR_HOME/app"

# --- 4. Launcher: ~/.local/bin/peon-editor ------------------------------------
mkdir -p "$BIN_DIR"
{
  echo '#!/bin/bash'
  echo '# peon-ping-editor launcher (written by the installer). Finds node itself, so nvm/Homebrew changes do not break it.'
  declare -f find_node
  echo 'NODE="$(find_node)" || { echo "peon-editor: Node.js 18+ not found" >&2; exit 1; }'
  echo "exec \"\$NODE\" \"$EDITOR_HOME/app/bin/peon-editor.js\" \"\$@\""
} > "$LAUNCHER"
chmod +x "$LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add it to run 'peon-editor' from a terminal:
    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac

# --- 5. PeonBar (macOS menu bar) -----------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
  say "Done. Run: peon-editor"
  exit 0
fi

BUILT=""
if xcrun --find swiftc >/dev/null 2>&1; then
  say "Building PeonBar"
  if BUILT="$(bash "$EDITOR_HOME/app/menubar/build.sh" "$TMP/build" 2>"$TMP/build.log" | tail -1)" && [ -d "$BUILT" ]; then :; else
    BUILT=""
    warn "Local build failed ($(tail -1 "$TMP/build.log" 2>/dev/null)); using the prebuilt app"
  fi
fi
if [ -z "$BUILT" ]; then
  say "Downloading prebuilt PeonBar"
  if curl -fsSL "https://github.com/$REPO/releases/latest/download/PeonBar.zip" -o "$TMP/PeonBar.zip" &&
     ditto -x -k "$TMP/PeonBar.zip" "$TMP/prebuilt" && [ -d "$TMP/prebuilt/PeonBar.app" ]; then
    BUILT="$TMP/prebuilt/PeonBar.app"
  fi
fi

if [ -z "$BUILT" ]; then
  warn "Could not build or download PeonBar, so the menu-bar app was skipped.
  Install Xcode Command Line Tools (xcode-select --install) and run this installer again.
  The editor itself works: peon-editor"
  exit 0
fi

pkill -x PeonBar 2>/dev/null || true
mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
ditto "$BUILT" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
defaults write com.peonping.peonbar editorLauncher "$LAUNCHER"

# LaunchAgent: start PeonBar at every login
mkdir -p "$(dirname "$AGENT")"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.peonping.peonbar</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>$APP</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
launchctl unload "$AGENT" 2>/dev/null || true
launchctl load -w "$AGENT" 2>/dev/null || true
open "$APP"

say "Done. PeonBar (the peon face) is in your menu bar and starts at login."
echo "    Open the editor from PeonBar → Open pack editor…, or run: peon-editor"
echo "    Uninstall: bash $EDITOR_HOME/app/uninstall.sh"
