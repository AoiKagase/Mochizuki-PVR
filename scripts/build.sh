#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

output=${1:-mochizuki}
count=$(git rev-list --count HEAD)
commit=$(git rev-parse --short=12 HEAD)
version="0.1.0-dev.${count}+${commit}"
if ! git diff --quiet; then
  version="${version}.dirty"
fi
date=$(date -u +%Y-%m-%dT%H:%M:%SZ)

go build \
  -ldflags "-X mochizuki/internal/version.Number=${version} -X mochizuki/internal/version.Commit=${commit} -X mochizuki/internal/version.Date=${date}" \
  -o "$output" ./cmd/mochizuki
printf 'Built Mochizuki PVR %s -> %s\n' "$version" "$output"
