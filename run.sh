#!/usr/bin/env bash
# Build once, then serve each repository on its own port, so each can be given
# its own public address.
#
#   ./run.sh                        # serves ../repos/<name> for the names below
#   REPOS_DIR=/srv/clones ./run.sh  # or point it somewhere else
set -euo pipefail
cd "$(dirname "$0")"

REPOS_DIR="${REPOS_DIR:-../repos}"
REPOS=("runyard:8090" "specdriver:8091")

echo "building…"
(cd web && npm run build >/dev/null)
go build -o quanticode ./cmd/quanticode

pkill -x quanticode 2>/dev/null || true
sleep 1

WEB="$PWD/web/dist"
for entry in "${REPOS[@]}"; do
  name="${entry%%:*}"
  port="${entry##*:}"
  if [ ! -d "$REPOS_DIR/$name/.git" ]; then
    echo "  skipping $name: no clone at $REPOS_DIR/$name"
    continue
  fi
  setsid ./quanticode -addr ":$port" -repo "$name=$REPOS_DIR/$name" -web "$WEB" \
    > "/tmp/quanticode-$name.log" 2>&1 &
  echo "  $name -> http://127.0.0.1:$port"
done

echo "warming caches…"
sleep 16
for entry in "${REPOS[@]}"; do
  port="${entry##*:}"
  if curl -sf "localhost:$port/api/repo" -o /dev/null; then
    echo "  :$port ok"
  else
    echo "  :$port not ready — see /tmp/quanticode-*.log"
  fi
done
