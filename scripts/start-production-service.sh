#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
case "${1:-}" in
  api)
    ENV_FILE="${QUALITY_API_ENV:-/etc/agentscore/api.env}"
    test -r "$ENV_FILE" || { echo "Missing API environment: $ENV_FILE" >&2; exit 1; }
    exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
      node --env-file="$ENV_FILE" server/dist/index.js
    ;;
  *) echo 'Usage: start-production-service.sh api' >&2; exit 2 ;;
esac
