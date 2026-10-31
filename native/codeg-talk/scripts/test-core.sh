#!/bin/bash
# Run the iPhone's Talk tests (CoreTests/Vendor, vendored with the sources)
# against the vendored Talk core (Sources/TalkCore) on macOS, with the Command
# Line Tools alone: they have no XCTest, so CoreTests/Shim stands in for it
# (only what the tests use) and runs every test method of every XCTestCase.
#
#   scripts/test-core.sh [test-name-filter]
#
# The core compiles as one module named Codeg, the app's module name, which is
# what the tests `@testable import`. Exits non-zero on any failure.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$HERE/.." && pwd)
OUT=${CODEG_TALK_CORE_TESTS_OUT:-$PKG/.build/core-tests}
FLAGS=(-swift-version 5 -Onone -target arm64-apple-macosx15.0 -D TALK_HARNESS)

"$HERE/sync-from-ios.sh" --check

CORE=()
while IFS= read -r f; do CORE+=("$f"); done < <(find "$PKG/Sources/TalkCore" -name '*.swift' | sort)
TESTS=()
while IFS= read -r f; do TESTS+=("$f"); done < <(find "$PKG/CoreTests/Vendor" -name '*.swift' | sort)
[ ${#CORE[@]} -gt 0 ] && [ ${#TESTS[@]} -gt 0 ] || { echo "nothing to test"; exit 1; }

mkdir -p "$OUT"
cd "$OUT"
if [ ! -f libXCTest.a ] || [ "$PKG/CoreTests/Shim/XCTest.swift" -nt libXCTest.a ]; then
  swiftc "${FLAGS[@]}" -parse-as-library -emit-library -static -emit-module -module-name XCTest \
    -o libXCTest.a "$PKG/CoreTests/Shim/XCTest.swift"
fi
swiftc "${FLAGS[@]}" -parse-as-library -enable-testing -emit-library -static -emit-module -module-name Codeg \
  -o libCodeg.a "${CORE[@]}"
{
  echo "import XCTest"
  echo "@testable import Codeg"
  echo "let allTestClasses: [XCTestCase.Type] = ["
  grep -ho 'class [A-Za-z0-9_]*: XCTestCase' "${TESTS[@]}" | awk '{sub(":","",$2); print "    " $2 ".self,"}'
  echo "]"
} > TestList.swift
swiftc "${FLAGS[@]}" -I . -L . -lXCTest -lCodeg -framework Accelerate -o runner \
  "$PKG/CoreTests/Shim/main.swift" TestList.swift "${TESTS[@]}"
./runner "$@"
