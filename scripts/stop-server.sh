#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${QUALITY_COMPOSE_PROJECT:-quality}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo 'Invalid Compose project name' >&2; exit 1; }
exec docker compose --compatibility --project-name "$PROJECT" --project-directory "$ROOT" \
  --env-file "$ROOT/.env" --file "$ROOT/compose.yaml" stop --timeout 60 api
