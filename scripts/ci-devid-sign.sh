#!/bin/bash
# Re-sign a built codeg.app with Jonathan's Developer ID and rebuild the
# updater archive from it. Runs in the build job on the self-hosted Mac
# runner only (see .github/workflows/build-app.yml).
#
#   scripts/ci-devid-sign.sh <bundle/macos dir>
#
# Why: macOS privacy grants (Accessibility, Screen Recording, keychain
# "Always Allow") are tied to the app's designated requirement. An ad-hoc
# build's requirement is its cdhash, which changes with every build, so each
# update silently dropped the grants. Signed with a Developer ID, the
# requirement is `identifier "app.codeg"` + Apple Developer ID + team
# 3L92BZK46V: the same for every build, so grants survive updates.
#
# What it does:
#   1. signs every nested Mach-O (helpers in Contents/MacOS, any dylibs or
#      nested bundles), deepest first, then the .app itself. No hardened
#      runtime (it changes what the app may spawn and load; only
#      notarization needs it) and no timestamp (needs Apple's server).
#   2. verifies the result and fails unless the designated requirement
#      names app.codeg and the team.
#   3. rebuilds codeg.app.tar.gz from the signed bundle, the way tauri does
#      (a single top-level codeg.app/), and deletes tauri's stale .sig. The
#      caller re-signs the archive with the updater key.
#
# The identity never leaves the Mac. It lives in the runner's own keychain,
# ~/actions-runner/_signing/codeg-signing.keychain-db (password in ./pw next
# to it), which is on no user keychain search list. codesign builds the
# certificate chain from the search list only, so for the duration of this
# script a throwaway HOME carries a search list holding just that keychain;
# the user's own search list, default and login keychains are never read or
# changed. Setup and rotation: docs/fork-solution-plan.md, "Fork builds:
# Developer ID signing".
set -euo pipefail

MACOS_DIR=${1:?usage: ci-devid-sign.sh <bundle/macos dir>}
APP="$MACOS_DIR/codeg.app"
IDENTITY=${CODEG_SIGN_IDENTITY:-A4DFC81686CC4636EB1CCCF1E7829EF7346C21E8}
TEAM=${CODEG_SIGN_TEAM:-3L92BZK46V}
BUNDLE_ID=app.codeg
# Entitlements for the app itself (Apple Events for agents that script other
# apps). Nested helpers keep none.
ENTITLEMENTS=${CODEG_SIGN_ENTITLEMENTS:-$(cd "$(dirname "$0")/.." && pwd)/src-tauri/codeg.entitlements}

# The runner runs with an isolated HOME, so resolve the account's real home.
REAL_HOME=$(python3 -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)')
SIGNING_DIR=${CODEG_SIGNING_DIR:-$REAL_HOME/actions-runner/_signing}
KEYCHAIN="$SIGNING_DIR/codeg-signing.keychain-db"
PASSWORD_FILE="$SIGNING_DIR/pw"

die() { echo "::error title=Developer ID signing::$*" >&2; exit 1; }

[ -d "$APP/Contents" ] || die "no app bundle at $APP"
[ -f "$ENTITLEMENTS" ] || die "entitlements file missing: $ENTITLEMENTS"
[ -f "$KEYCHAIN" ] && [ -f "$PASSWORD_FILE" ] ||
  die "signing keychain missing ($KEYCHAIN); see docs/fork-solution-plan.md"

SIGN_HOME=$(mktemp -d)
cleanup() {
  HOME="$SIGN_HOME" security lock-keychain "$KEYCHAIN" 2>/dev/null || true
  rm -rf "$SIGN_HOME"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$SIGN_HOME/Library/Preferences"
sec() { HOME="$SIGN_HOME" security "$@"; }
sec list-keychains -d user -s "$KEYCHAIN"
[ "$(sec list-keychains -d user | tr -d ' "')" = "$KEYCHAIN" ] ||
  die "could not scope the search list to the signing keychain"
sec unlock-keychain -p "$(cat "$PASSWORD_FILE")" "$KEYCHAIN"

sign() {
  HOME="$SIGN_HOME" codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" \
    --timestamp=none --preserve-metadata=entitlements "$@"
}

main_exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")

# Deepest first: nested code must be signed before whatever contains it.
by_depth() { awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-; }
machos=$(find "$APP/Contents" -type f -print0 | xargs -0 file -F $'\t' |
  awk -F'\t' '$2 ~ /Mach-O/ { print $1 }' | by_depth)
[ -n "$machos" ] || die "no Mach-O files found in $APP"

while IFS= read -r f; do
  [ "$f" = "$APP/Contents/MacOS/$main_exe" ] && continue
  echo "signing $f"
  sign --identifier "$BUNDLE_ID.$(basename "$f")" "$f"
done <<< "$machos"

while IFS= read -r b; do
  echo "signing $b"
  sign "$b"
done < <(find "$APP/Contents" -depth -type d \
  \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o -name '*.appex' -o -name '*.bundle' \) | by_depth)

echo "signing $APP (entitlements: ${ENTITLEMENTS##*/})"
HOME="$SIGN_HOME" codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" \
  --timestamp=none --entitlements "$ENTITLEMENTS" "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
requirement=$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')
echo "designated requirement: $requirement"
case "$requirement" in
  *cdhash*) die "designated requirement is a cdhash: $requirement" ;;
esac
[[ "$requirement" == *"identifier \"$BUNDLE_ID\""* && "$requirement" == *"\"$TEAM\""* ]] ||
  die "designated requirement lacks $BUNDLE_ID / team $TEAM: $requirement"

codesign -d --entitlements - "$APP" 2>/dev/null | grep -q 'com.apple.security.automation.apple-events' ||
  die "the app lost its Apple Events entitlement"
/usr/libexec/PlistBuddy -c 'Print :NSAppleEventsUsageDescription' "$APP/Contents/Info.plist" >/dev/null 2>&1 ||
  die "Info.plist has no NSAppleEventsUsageDescription (src-tauri/Info.plist not merged?)"

# Every Mach-O in the bundle carries the team.
while IFS= read -r f; do
  team=$(codesign -dv "$f" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [ "$team" = "$TEAM" ] || die "$f is signed for team '$team', not $TEAM"
  echo "team $team: ${f#"$APP/"}"
done <<< "$machos"

# Updater archive: same layout as tauri's (entries under codeg.app/), and
# no AppleDouble or xattr entries, which would land inside the bundle on
# extraction and break its seal.
TARGZ="$MACOS_DIR/codeg.app.tar.gz"
rm -f "$TARGZ" "$TARGZ.sig"
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --no-acls --no-fflags \
  -czf "$TARGZ" -C "$MACOS_DIR" codeg.app
if tar -tzf "$TARGZ" | grep -v -e '^codeg\.app/' -e '^codeg\.app$' | grep -q .; then
  die "archive has entries outside codeg.app/"
fi
if tar -tzf "$TARGZ" | grep -q '/\._'; then
  die "archive has AppleDouble entries"
fi

# What an installed app will unpack must still verify.
check_dir=$(mktemp -d)
tar -xzf "$TARGZ" -C "$check_dir"
codesign --verify --deep --strict "$check_dir/codeg.app" ||
  { rm -rf "$check_dir"; die "the unpacked archive fails verification"; }
rm -rf "$check_dir"

echo "Developer ID signed: $APP"
echo "archive rebuilt: $TARGZ ($(du -h "$TARGZ" | cut -f1))"
