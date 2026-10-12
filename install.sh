#!/bin/bash
# peon-ping-editor installer: the editor UI plus, on macOS, the PeonBar menu-bar app (starts at login).
#
#   curl -fsSL https://raw.githubusercontent.com/Ferosima/peon-ping-editor/main/install.sh | bash
#
# Re-run it any time to update. Environment overrides:
#   PEON_EDITOR_REF   branch or tag to install (default: main)
#   PEON_EDITOR_HOME  where the app lives (default: ~/.peon-editor)
#   PEON_DIR          peon-ping install dir (default: ~/.claude/hooks/peon-ping)
#   PEON_EDITOR_NO_MENUBAR=1  skip PeonBar (editor only)
#
# Everything runs from main() at the bottom, so a download cut off half-way does nothing.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "peon-ping-editor: run this installer with bash (curl ... | bash), not sh" >&2
  exit 1
fi

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

# Copied verbatim into the launcher, so the installer and PeonBar agree on which node to use.
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

# Without the Command Line Tools, even `xcrun --find` pops up an "install developer tools" dialog
have_swiftc() {
  xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1
}

check_peon_ping() {
  [ -f "$PEON_DIR/peon.sh" ] && return 0
  die "peon-ping is not installed (looked in $PEON_DIR).
  Install it first, then run this installer again:

    curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash

  or with Homebrew:  brew install PeonPing/tap/peon-ping && peon-ping-setup"
}

# Prints the directory holding the app sources: this checkout, or a fresh download
fetch_sources() {
  local here=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  fi
  # A checkout (bash install.sh) installs itself; the installed copy in ~/.peon-editor downloads the latest instead
  if [ -n "$here" ] && [ -f "$here/bin/peon-editor.js" ] && [ "$here" != "$(cd "$EDITOR_HOME" 2>/dev/null && pwd -P)/app" ]; then
    echo "$here"
    return
  fi
  say "Downloading $REPO@$REF" >&2
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$TMP/src.tar.gz" || die "Download failed: https://github.com/$REPO (ref $REF)"
  mkdir -p "$TMP/src"
  tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" || die "Could not unpack the download"
  local dir
  for dir in "$TMP"/src/*/; do
    if [ -f "$dir/bin/peon-editor.js" ]; then
      echo "${dir%/}"
      return
    fi
  done
  die "Unexpected archive layout"
}

install_app() {
  local src="$1" item
  # A running editor keeps the old code in memory; stop it so the next launch picks up this version
  pkill -f "$EDITOR_HOME/app/bin/peon-editor.js" 2>/dev/null || true
  mkdir -p "$EDITOR_HOME"
  rm -rf "$EDITOR_HOME/app.new"
  mkdir -p "$EDITOR_HOME/app.new"
  for item in bin src public menubar package.json LICENSE README.md install.sh uninstall.sh; do
    if [ -e "$src/$item" ]; then
      cp -R "$src/$item" "$EDITOR_HOME/app.new/"
    fi
  done
  [ -f "$EDITOR_HOME/app.new/bin/peon-editor.js" ] || die "Copy failed"
  rm -rf "$EDITOR_HOME/app"
  mv "$EDITOR_HOME/app.new" "$EDITOR_HOME/app"
  VERSION="$(PKG="$EDITOR_HOME/app/package.json" "$NODE" -p "require(process.env.PKG).version")"
  say "Installed peon-ping-editor $VERSION to $EDITOR_HOME/app"
}

write_launcher() {
  mkdir -p "$BIN_DIR"
  {
    echo '#!/bin/bash'
    echo '# peon-ping-editor launcher (written by the installer).'
    echo '# Finds node on its own and fixes PATH, because PeonBar and launchd start it with a bare PATH.'
    echo 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'
    printf 'export PEON_DIR=%q\n' "$PEON_DIR"
    declare -f find_node
    echo 'NODE="$(find_node)" || { echo "peon-editor: Node.js 18+ not found" >&2; exit 1; }'
    printf 'exec "$NODE" %q "$@"\n' "$EDITOR_HOME/app/bin/peon-editor.js"
  } > "$LAUNCHER.new"
  chmod +x "$LAUNCHER.new"
  mv "$LAUNCHER.new" "$LAUNCHER"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH. To run 'peon-editor' from a terminal, add it:
    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
  esac
}

# Prints the path of a PeonBar.app to install, or nothing
get_peonbar() {
  local built
  if have_swiftc; then
    say "Building PeonBar" >&2
    if built="$(bash "$EDITOR_HOME/app/menubar/build.sh" "$TMP/build" 2>"$TMP/build.log" | tail -1)" && [ -d "$built" ]; then
      echo "$built"
      return
    fi
    warn "Building PeonBar failed: $(tail -1 "$TMP/build.log" 2>/dev/null)"
  fi
  say "Downloading prebuilt PeonBar" >&2
  if curl -fsSL "https://github.com/$REPO/releases/latest/download/PeonBar.zip" -o "$TMP/PeonBar.zip" 2>/dev/null &&
     ditto -x -k "$TMP/PeonBar.zip" "$TMP/prebuilt" && [ -d "$TMP/prebuilt/PeonBar.app" ]; then
    echo "$TMP/prebuilt/PeonBar.app"
  fi
}

install_peonbar() {
  local built
  built="$(get_peonbar)"
  if [ -z "$built" ]; then
    warn "PeonBar was skipped: it could not be built (no Xcode Command Line Tools) or downloaded.
  Install the tools with: xcode-select --install   then run this installer again.
  The editor works without it: peon-editor"
    return 1
  fi

  pkill -x PeonBar 2>/dev/null || true
  mkdir -p "$(dirname "$APP")"
  rm -rf "$APP"
  ditto "$built" "$APP"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  defaults write com.peonping.peonbar editorLauncher "$LAUNCHER"
  defaults write com.peonping.peonbar peonDir "$PEON_DIR"

  # LaunchAgent: start PeonBar at every login. Pointing at the binary (not /usr/bin/open) and naming the bundle
  # makes System Settings → Login Items show "PeonBar" instead of "open".
  mkdir -p "$(dirname "$AGENT")"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.peonping.peonbar</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/PeonBar</string></array>
  <key>AssociatedBundleIdentifiers</key><array><string>com.peonping.peonbar</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/com.peonping.peonbar" 2>/dev/null || launchctl unload "$AGENT" 2>/dev/null || true
  # bootstrap starts it right away (RunAtLoad); fall back to opening the app directly
  launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null || launchctl load -w "$AGENT" 2>/dev/null || true
  sleep 1
  pgrep -x PeonBar >/dev/null || open "$APP"
  return 0
}

main() {
  check_peon_ping
  NODE="$(find_node)" || die "Node.js 18 or newer is required.
  Install it (for example: brew install node) and run this installer again."
  say "Using Node $("$NODE" -v) ($NODE)"

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # A plain assignment, so a failed download stops the installer (set -e ignores failures inside arguments)
  local src
  src="$(fetch_sources)"
  install_app "$src"
  write_launcher

  if [ "$(uname -s)" != "Darwin" ] || [ "${PEON_EDITOR_NO_MENUBAR:-}" = 1 ]; then
    say "Done. Run: peon-editor"
    return
  fi
  if install_peonbar; then
    say "Done. PeonBar (the peon face) is in your menu bar and starts at login."
    echo "    Open the editor from PeonBar → Open pack editor…, or run: peon-editor"
  else
    say "Done (without PeonBar). Run: peon-editor"
  fi
  echo "    Update: run the same install command again"
  echo "    Uninstall: bash $EDITOR_HOME/app/uninstall.sh"
}

main "$@"
