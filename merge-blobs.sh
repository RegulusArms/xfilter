#!/usr/bin/env bash
# Merge downloaded ingest blobs into one deduplicated accounts file.
# Usage: ./merge-blobs.sh <blob-download-dir> [output.json]
# If the output file already exists it is merged in too, so history accumulates.
# Per handle: manual record wins, else newest checkedAt; keeps earliest firstSeen,
# latest checkedAt, and any non-empty comment.
set -euo pipefail

command -v jq >/dev/null || { echo "jq not found: sudo apt install jq" >&2; exit 1; }

src="${1:?usage: $0 <blob-download-dir> [output.json]}"
out="${2:-merged.json}"

inputs=()
while IFS= read -r -d '' f; do
  if jq -e 'type == "array"' "$f" >/dev/null 2>&1; then
    inputs+=("$f")
  else
    echo "skipping (not a JSON array): $f" >&2
  fi
done < <(find "$src" -type f -print0)
[[ -f "$out" ]] && inputs+=("$out")

(( ${#inputs[@]} )) || { echo "no input files found in $src" >&2; exit 1; }

tmp="$(mktemp)"
jq -s '
  [ .[][] ]
  | map(select(.handle) | .handle |= (ascii_downcase | ltrimstr("@")))
  | group_by(.handle)
  | map(. as $g
      | ($g | sort_by([(.manual // false), (.checkedAt // "")]) | last) as $w
      | $w + {
          firstSeen: ([$g[].firstSeen | select(. != null and . != "")] | min),
          checkedAt: ([$g[].checkedAt | select(. != null)] | max),
          comment: (if ($w.comment // "") != "" then $w.comment
                    else ([$g[].comment | select(. != null and . != "")] | last // "") end)
        })
' "${inputs[@]}" > "$tmp"
mv "$tmp" "$out"

echo "$(jq length "$out") unique accounts from ${#inputs[@]} files -> $out"
