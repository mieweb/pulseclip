#!/usr/bin/env bash
# Box-side release for the PulseClip dev instance.
#
# Takes a release tarball built by .github/workflows/deploy-dev.yml, installs
# it under releases/<name>/, wires in shared state (artipods, .env), flips the
# `current` symlink, restarts the app, and healthchecks. On a failed
# healthcheck it flips back to the previous release and restarts that.
#
# Usage: release.sh <release-tarball>
# Env:
#   APP_ROOT     layout root (default ~/pulseclip-app): releases/ shared/ current
#   RESTART_CMD  command to (re)start the app after the symlink flip
#                (default: pm2 restart-or-start on current/server/dist/index.js)
#   HEALTH_PATH  healthcheck path (default /api/providers)
set -euo pipefail

TARBALL=${1:?usage: release.sh <release-tarball>}
APP_ROOT=${APP_ROOT:-$HOME/pulseclip-app}
SHARED="$APP_ROOT/shared"
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
HEALTH_PATH=${HEALTH_PATH:-/api/providers}

NAME=$(basename "$TARBALL" .tar.gz)
REL="$RELEASES/$NAME"

mkdir -p "$RELEASES" "$SHARED/artipods" "$SHARED/cache" "$SHARED/data" "$SHARED/tus-uploads" "$SHARED/vault-data"
rm -rf "$REL"
mkdir -p "$REL"
tar -xzf "$TARBALL" -C "$REL"

# Shared state survives deploys; releases are disposable.
# cache/ = transcription cache, data/ = upload checksum index,
# tus-uploads/ = in-flight resumable uploads,
# vault-data/ = pulsevault artifact store (bytes + sidecars + in-flight
# TUS state; losing it 404s /pulsevault/artifacts links and breaks
# resume across deploys) — all served from server/ cwd.
ln -sfn "$SHARED/artipods" "$REL/server/artipods"
ln -sfn "$SHARED/cache" "$REL/server/cache"
ln -sfn "$SHARED/data" "$REL/server/data"
ln -sfn "$SHARED/tus-uploads" "$REL/server/tus-uploads"
ln -sfn "$SHARED/vault-data" "$REL/server/vault-data"
if [ -f "$SHARED/env" ]; then
  ln -sf "$SHARED/env" "$REL/server/.env"
fi

(cd "$REL" && npm ci --omit=dev --workspace=server --no-audit --no-fund)

PREV=$(readlink "$CURRENT" 2>/dev/null || true)
ln -sfn "$REL" "$CURRENT"

RESTART_CMD=${RESTART_CMD:-"pm2 restart pulseclip-dev --update-env 2>/dev/null || pm2 start \"$CURRENT/server/dist/index.js\" --name pulseclip-dev --cwd \"$CURRENT/server\""}
bash -c "$RESTART_CMD"

PORT=3000
if [ -f "$SHARED/env" ]; then
  PORT=$(sed -n 's/^PORT=//p' "$SHARED/env" | tail -1)
  PORT=${PORT:-3000}
fi

healthy() {
  i=0
  until curl -fsS "localhost:$PORT$HEALTH_PATH" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && return 1
    sleep 1
  done
}

if healthy; then
  echo "release OK: current -> $NAME (healthcheck $PORT$HEALTH_PATH)"
else
  echo "HEALTHCHECK FAILED for $NAME" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    echo "rolling back: current -> $(basename "$PREV")" >&2
    ln -sfn "$PREV" "$CURRENT"
    bash -c "$RESTART_CMD"
    if healthy; then
      echo "rollback healthy" >&2
    else
      echo "rollback ALSO unhealthy — manual intervention needed" >&2
    fi
  else
    echo "no previous release to roll back to" >&2
  fi
  exit 1
fi

# Keep the two newest releases (current + previous); prune the rest.
ls -1t "$RELEASES" | tail -n +3 | while read -r old; do
  rm -rf "$RELEASES/$old"
done
