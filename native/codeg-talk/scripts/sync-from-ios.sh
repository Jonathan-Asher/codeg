#!/bin/bash
# Vendor the iPhone's Talk sources into codeg-talk, at a pinned codeg-ios commit.
#
#   scripts/sync-from-ios.sh --commit <ref> [--repo <codeg-ios checkout>]
#   scripts/sync-from-ios.sh            re-vendor the commit vendor.lock names
#   scripts/sync-from-ios.sh --check    verify the vendored files against vendor.lock
#
# What is vendored (the manifests below):
#   Sources/TalkCore/Vendor     the portable Talk logic, its models and support
#                               files: compiled as one module, unchanged.
#   Sources/TalkEngines/Vendor  the engines' adapters and the files that import
#                               whisper.cpp or ExceptionCatcher.
#   ../SherpaOnnx ../SmartTurn ../WhisperCpp ../ExceptionCatcher
#                               the engine packages, whole.
#
# Files are read with `git show <commit>:<path>`: the codeg-ios checkout and
# its branches are never touched. vendor.lock records the commit and, for every
# vendored file, its sha256 and where it came from; --check recomputes the
# hashes and fails on any difference, a missing file or an unlisted file in a
# vendor directory. The vendor directories are owned by this script: files no
# longer in the manifest are deleted.
#
# The portable Talk logic is codeg-ios's CodegiOS/Features/Talk/Core/ (every
# file in it is vendored, so a new one comes along by itself); the engine
# adapters in it (TalkEngineAdapters.swift) go to TalkEngines, so TalkCore and
# TalkHost build without the engine packages.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$HERE/.." && pwd)
COMMON=$(git -C "$PKG" rev-parse --path-format=absolute --git-common-dir)
REPO=${CODEG_IOS_REPO:-$(dirname "$(dirname "$COMMON")")/codeg-ios}
COMMIT=""
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

exec python3 -I - "$PKG" "$REPO" "$COMMIT" "$CHECK" <<'PY'
import hashlib, os, subprocess, sys
from pathlib import Path

pkg, repo, commit, check = sys.argv[1:5]
pkg = Path(pkg)
LOCK = pkg / "vendor.lock"
CORE_DIR = "Sources/TalkCore/Vendor"
ENGINES_DIR = "Sources/TalkEngines/Vendor"
PACKAGES = ["SherpaOnnx", "SmartTurn", "WhisperCpp", "ExceptionCatcher"]

CORE = "CodegiOS/Features/Talk/Core"
# The adapters over the engine packages: compiled in TalkEngines.
ENGINE_CORE_FILES = {"TalkEngineAdapters.swift"}
SUPPORT = {
    # destination under the vendor dir: source
    CORE_DIR: {
        "Models/AnyJSON.swift": "CodegiOS/Models/AnyJSON.swift",
        "Models/Message.swift": "CodegiOS/Models/Message.swift",
        "Models/InteractiveRequests.swift": "CodegiOS/Models/InteractiveRequests.swift",
        "Models/PendingItem.swift": "CodegiOS/Models/PendingItem.swift",
        "Support/TranscriptTime.swift": "CodegiOS/Features/SessionDetail/TranscriptTime.swift",
        "Support/UnifiedDiff.swift": "CodegiOS/Features/SessionDetail/Rendering/UnifiedDiff.swift",
        "Support/SpeechText.swift": "CodegiOS/Features/Voice/SpeechText.swift",
        "Support/MicrophoneConverter.swift": "CodegiOS/Features/Dictation/MicrophoneConverter.swift",
        "Support/MicrophoneFormat.swift": "CodegiOS/Features/Dictation/MicrophoneFormat.swift",
        "Support/SpeechToText.swift": "CodegiOS/Features/Dictation/SpeechToText.swift",
        "Support/DictationLanguage.swift": "CodegiOS/Features/Dictation/DictationLanguage.swift",
        "Support/DictationText.swift": "CodegiOS/Features/Dictation/DictationText.swift",
    },
    ENGINES_DIR: {
        "StreamingSileroVAD.swift": "CodegiOS/Features/Voice/StreamingSileroVAD.swift",
        "WhisperCppEngine.swift": "CodegiOS/Features/Dictation/WhisperCppEngine.swift",
        "AVFAudioGuard.swift": "CodegiOS/Features/Voice/AVFAudioGuard.swift",
    },
}


def git(*args, binary=False):
    out = subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)
    return out.stdout if binary else out.stdout.decode()


def show(path):
    return git("show", f"{commit}:{path}", binary=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def manifest():
    """(destination, source) for every vendored Talk file at the commit."""
    listed = git("ls-tree", "-r", "--name-only", commit, "--", f"{CORE}/").split()
    core_files = [p for p in listed if p.endswith(".swift")]
    if not core_files:
        sys.exit(f"{commit} has no {CORE}/ (codeg-ios before the Talk core split)")
    out = []
    for path in core_files:
        rel = path[len(CORE) + 1:]
        if Path(rel).name in ENGINE_CORE_FILES:
            out.append((f"{ENGINES_DIR}/{Path(rel).name}", path))
        else:
            out.append((f"{CORE_DIR}/Talk/{rel}", path))
    for root, files in SUPPORT.items():
        for dest, source in files.items():
            out.append((f"{root}/{dest}", source))
    return out


def package_entries():
    entries = []
    for name in PACKAGES:
        for path in git("ls-tree", "-r", "--name-only", commit, "--", f"Packages/{name}/").split():
            entries.append((f"../{name}/{path[len(f'Packages/{name}/'):]}", path))
    return entries


def read_lock():
    if not LOCK.exists():
        sys.exit("no vendor.lock; run with --commit first")
    meta, files = {}, []
    for line in LOCK.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("@"):
            key, _, value = line[1:].partition(" ")
            meta[key] = value.strip()
            continue
        digest, dest, source = line.split("  ", 2)
        files.append((digest, dest, source))
    return meta, files


def owned_files():
    """Every file in the directories this script owns."""
    out = set()
    for d in [CORE_DIR, ENGINES_DIR]:
        for p in (pkg / d).rglob("*"):
            if p.is_file():
                out.add(str(p.relative_to(pkg)))
    for name in PACKAGES:
        root = pkg / ".." / name
        for p in root.rglob("*"):
            if p.is_file() and ".build" not in p.parts and ".swiftpm" not in p.parts:
                out.add(os.path.normpath(os.path.relpath(p, pkg)))
    return out


if check == "1":
    meta, files = read_lock()
    bad = []
    for digest, dest, source in files:
        p = pkg / dest
        if not p.exists():
            bad.append(f"missing: {dest}")
        elif sha(p.read_bytes()) != digest:
            bad.append(f"changed: {dest} (from {source})")
    listed = {os.path.normpath(dest) for _, dest, _ in files}
    for extra in sorted(owned_files() - listed):
        bad.append(f"not in vendor.lock: {extra}")
    if bad:
        print("vendor.lock check FAILED:", *bad, sep="\n  ")
        print("Vendored files are never edited by hand: change them in codeg-ios and re-run this script.")
        sys.exit(1)
    print(f"vendor.lock OK: {len(files)} files from codeg-ios {meta.get('commit', '?')[:12]}")
    sys.exit(0)

if not commit:
    commit = read_lock()[0].get("commit") or sys.exit("no --commit and no commit in vendor.lock")
commit = git("rev-parse", "--verify", f"{commit}^{{commit}}").strip()
entries = manifest() + package_entries()

written, lock_lines = set(), []
for dest, source in entries:
    data = show(source)
    path = pkg / dest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    norm = os.path.normpath(dest)
    written.add(norm)
    lock_lines.append(f"{sha(data)}  {norm}  {source}")

for stale in sorted(owned_files() - written):
    (pkg / stale).unlink()
    print(f"removed {stale}")

subject = git("log", "-1", "--format=%s", commit).strip()
LOCK.write_text(
    "# codeg-talk vendor.lock: written by scripts/sync-from-ios.sh, checked by\n"
    "# `scripts/sync-from-ios.sh --check`. Never edit vendored files by hand.\n"
    f"@repo Jonathan-Asher/codeg-ios\n@commit {commit}\n@subject {subject[:120]}\n"
    + "\n".join(sorted(lock_lines)) + "\n")
print(f"vendored {len(written)} files from codeg-ios {commit[:12]}")
