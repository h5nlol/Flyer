#!/usr/bin/env bash
# FlyWire FAFB v783 (Codex snapshot). CC BY-NC 4.0 — non-commercial use only.
set -euo pipefail
BASE="https://storage.googleapis.com/flywire-data/codex/data/fafb/783"
DIR="$(cd "$(dirname "$0")/.." && pwd)/data"
mkdir -p "$DIR"

for f in connections.csv.gz classification.csv.gz coordinates.csv.gz consolidated_cell_types.csv.gz; do
  if [ -s "$DIR/$f" ]; then
    echo "skip  $f (present)"
  else
    echo "get   $f"
    curl -fL --progress-bar -o "$DIR/$f" "$BASE/$f"
  fi
done

echo
du -h "$DIR"/*.csv.gz
