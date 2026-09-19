#!/bin/bash
# Install the codeg fork + patched pi-acp on Jonathan's MacBook.
# Run ON the MacBook:  curl -sL https://github.com/Jonathan-Asher/codeg/releases/download/fork-latest/install.sh | bash
# App install no longer depends on npm succeeding.

FAILURES=""

echo "==> 1/4 Installing patched pi-acp (session fork/resume + extension commands)"
if command -v npm >/dev/null 2>&1; then
  npm install -g github:Jonathan-Asher/pi-acp#main || FAILURES="$FAILURES pi-acp(npm)"
else
  echo "   npm not found — skipping pi-acp (app install continues)"
  FAILURES="$FAILURES pi-acp(no-npm)"
fi

echo "==> 2/4 Downloading codeg fork app (~90MB)"
curl -sL -o /tmp/codeg-fork.app.zip "https://github.com/Jonathan-Asher/codeg/releases/download/fork-latest/codeg-fork.app.zip?cb=$(date +%s)" || { echo "FAILED: app download"; exit 1; }

echo "==> 3/4 Installing app (backup of the old one at /Applications/codeg.app.bak)"
osascript -e 'tell application "codeg" to quit' 2>/dev/null || true
sleep 2
rm -rf /Applications/codeg.app.bak
[ -d /Applications/codeg.app ] && mv /Applications/codeg.app /Applications/codeg.app.bak
unzip -oq /tmp/codeg-fork.app.zip -d /tmp/codeg-unzip || { echo "FAILED: unzip"; exit 1; }
ditto /tmp/codeg-unzip/codeg.app /Applications/codeg.app
rm -rf /tmp/codeg-fork.app.zip /tmp/codeg-unzip
xattr -dr com.apple.quarantine /Applications/codeg.app 2>/dev/null || true

echo "==> 4/4 Relaunching codeg"
open /Applications/codeg.app

echo ""
if [ -n "$FAILURES" ]; then
  echo "APP INSTALLED (with warnings:$FAILURES) — old app at /Applications/codeg.app.bak"
else
  echo "SUCCESS — codeg fork fully installed. Old app at /Applications/codeg.app.bak"
fi
