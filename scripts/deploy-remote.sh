#!/bin/bash
# Deploy the codeg fork (cmd+F, Pi fork-points) + patched pi-acp to a Mac.
# Usage: ./deploy-remote.sh [user@host]
# Tested topology: codeg.app in /Applications, pi-acp installed globally via npm.
set -euo pipefail

HOST="${1:?usage: deploy-remote.sh user@host}"
APP_SRC="$HOME/Work/codeg/src-tauri/target/release/bundle/macos/codeg.app"

echo "==> 1/4 Installing pi-acp fork (fork/resume/extension-commands) on $HOST"
ssh "$HOST" "npm install -g github:Jonathan-Asher/pi-acp#main"

echo "==> 2/4 Verifying pi-acp has fork support"
ssh "$HOST" "grep -c unstable_forkSession \$(dirname \$(readlink -f \$(which pi-acp)))/index.js || npm root -g"

echo "==> 3/4 Copying codeg.app (110MB) — takes a moment over Tailscale"
ditto -c -k --keepParent "$APP_SRC" /tmp/codeg-fork.app.zip
scp /tmp/codeg-fork.app.zip "$HOST:/tmp/"

echo "==> 4/4 Installing app (kills any running codeg there — safe if none)"
ssh "$HOST" "
  osascript -e 'tell application \"codeg\" to quit' 2>/dev/null || true
  sleep 2
  rm -rf /Applications/codeg.app.bak
  [ -d /Applications/codeg.app ] && mv /Applications/codeg.app /Applications/codeg.app.bak
  cd /tmp && unzip -oq codeg-fork.app.zip -d /tmp/codeg-unzip
  ditto /tmp/codeg-unzip/codeg.app /Applications/codeg.app
  rm -rf /tmp/codeg-fork.app.zip /tmp/codeg-unzip
  xattr -dr com.apple.quarantine /Applications/codeg.app 2>/dev/null || true
  echo 'installed. backup at /Applications/codeg.app.bak'
"
echo "DONE on $HOST"
