#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PROJECT="${QUALITY_COMPOSE_PROJECT:-quality}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo 'Invalid Compose project name' >&2; exit 1; }

# The existing launcher builds first, preserves storage, and waits for API health.
bash "$ROOT/scripts/start-server.sh"

COMPOSE=(docker compose --compatibility --project-name "$PROJECT" --project-directory "$ROOT"
  --env-file "$ROOT/.env" --file "$ROOT/compose.yaml")
BACKUP="/var/lib/agentscore-storage/data/before-confirmed-repair-$(date -u +%Y%m%dT%H%M%SZ)-$$.db"

# Explicit update only: never run historical repair as an application startup side effect.
# The CLI skips ambiguous history and creates a verified private backup before changes.
"${COMPOSE[@]}" exec -T api node server/dist/reviewerAssignment/repairCli.js \
  --db /var/lib/agentscore-storage/data/data.db --repair-confirmed --backup "$BACKUP"

echo 'Обновление кода и проверка подтверждённых старых автозадач завершены.'
