#!/bin/sh
# Download the BlueTTSKit model files (~575 MB) into DEST with the layout
# BlueTTS(modelDirectory:) expects, pinned to exact revisions and verified
# against scripts/models.sha256.
#
#   scripts/fetch-models.sh DEST            download from Hugging Face / GitHub
#   scripts/fetch-models.sh DEST --verify   only check what is already in DEST
#
# Re-running is cheap: files whose checksum already matches are skipped.
set -eu

DEST=${1:?usage: fetch-models.sh DEST [--verify]}
MODE=${2:-}
HERE=$(cd "$(dirname "$0")" && pwd)
SUMS="$HERE/models.sha256"
mkdir -p "$DEST"

url_for() {
  # hf:repo@rev:path  ->  https://huggingface.co/repo/resolve/rev/path
  # gh:owner/repo@rev:path  ->  https://raw.githubusercontent.com/owner/repo/rev/path
  src=$1
  kind=${src%%:*}; rest=${src#*:}
  repo=${rest%%@*}; rest=${rest#*@}
  rev=${rest%%:*}; path=${rest#*:}
  case $kind in
    hf) echo "https://huggingface.co/$repo/resolve/$rev/$path" ;;
    gh) echo "https://raw.githubusercontent.com/$repo/$rev/$path" ;;
    *) echo "unknown source $src" >&2; exit 1 ;;
  esac
}

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

fail=0
grep -v '^#' "$SUMS" | while read -r sum path src; do
  [ -n "$sum" ] || continue
  out="$DEST/$path"
  if [ -f "$out" ] && [ "$(sha "$out")" = "$sum" ]; then
    echo "ok       $path"
    continue
  fi
  if [ "$MODE" = "--verify" ]; then
    echo "MISSING  $path" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$out")"
  url=$(url_for "$src")
  echo "fetch    $path  <-  $url"
  curl -fL --retry 3 --progress-bar -o "$out.part" "$url"
  got=$(sha "$out.part")
  if [ "$got" != "$sum" ]; then
    echo "CHECKSUM MISMATCH for $path: got $got, want $sum" >&2
    rm -f "$out.part"
    exit 1
  fi
  mv "$out.part" "$out"
done
echo "models ready in $DEST"
du -sh "$DEST"
