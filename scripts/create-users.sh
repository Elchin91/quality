#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${QUALITY_COMPOSE_PROJECT:-quality}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo 'Invalid Compose project name' >&2; exit 1; }
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--dry-run" ) ]]; then
  echo 'Usage: sudo bash scripts/create-users.sh [--dry-run]' >&2
  exit 1
fi
[[ -r "$ROOT/.env" ]] || { echo 'Server .env is missing or unreadable' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose V2 is required' >&2; exit 1; }
args=(--apply --show-password)
if [[ $# -eq 1 ]]; then args=(--dry-run); fi
# Credentials remain in server storage; only the administrator's terminal shows the new password.
docker compose --compatibility --project-name "$PROJECT" --project-directory "$ROOT" \
  --env-file "$ROOT/.env" --file "$ROOT/compose.yaml" \
  exec -T api node server/dist/users/provisionCli.js "${args[@]}"
