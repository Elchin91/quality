#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PROJECT="${QUALITY_COMPOSE_PROJECT:-quality}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo 'Invalid Compose project name' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Install python3 first' >&2; exit 1; }
if ! docker compose version >/dev/null 2>&1; then
  echo 'Install Compose V2: sudo apt-get update && sudo apt-get install -y docker-compose-v2' >&2
  exit 1
fi
docker info >/dev/null 2>&1 || { echo 'Run: sudo bash scripts/start-server.sh' >&2; exit 1; }
[[ -r .env ]] || { echo 'Missing server .env; use config/production/api.env.example as the template' >&2; exit 1; }
COMPOSE=(docker compose --compatibility --project-name "$PROJECT" --project-directory "$ROOT"
  --env-file "$ROOT/.env" --file "$ROOT/compose.yaml")

umask 077
resolved="$(mktemp)"
trap 'rm -f -- "$resolved"' EXIT
"${COMPOSE[@]}" config --format json > "$resolved"
python3 - "$resolved" <<'PY'
import json, os, pathlib, re, stat, sys

def fail(message):
    sys.exit('Configuration: ' + message)

api = json.load(open(sys.argv[1]))['services']['api']
env = api['environment']
user = str(api['user'])
if not re.fullmatch(r'[0-9]+:[0-9]+', user):
    fail('QUALITY_UID and QUALITY_GID must be numeric')
uid, gid = map(int, user.split(':'))
if not (0 < uid < 2**31 and 0 < gid < 2**31):
    fail('QUALITY_UID and QUALITY_GID must be non-root IDs below 2147483648')
mounts = [m for m in api.get('volumes', []) if m.get('target') == '/var/lib/agentscore-storage']
if len(mounts) != 1 or mounts[0].get('type') != 'bind':
    fail('expected a bind mount at /var/lib/agentscore-storage')
storage = pathlib.Path(mounts[0]['source'])
if not storage.is_absolute() or storage == pathlib.Path('/') or storage.resolve() != storage:
    fail('QUALITY_STORAGE_DIR must be an absolute directory without symlinks or ..')
if env.get('DATA_DIR') != '/var/lib/agentscore-storage/data':
    fail('DATA_DIR must match the persistent storage mount')
origins = str(env.get('CORS_ORIGINS', '')).split(',')
internal_http = env.get('QUALITY_INTERNAL_HTTP')
if internal_http == 'true':
    if [o.strip() for o in origins] != ['http://192.168.68.41:8787']:
        fail('internal HTTP is limited to http://192.168.68.41:8787')
    if str(env.get('TRUST_PROXY')) != '0':
        fail('direct internal HTTP requires QUALITY_TRUST_PROXY=0')
elif internal_http != 'false' or any(not o.strip().startswith('https://') for o in origins):
    fail('use the pinned internal HTTP profile or QUALITY_INTERNAL_HTTP=false with an HTTPS origin')
data = storage / 'data'
for path in (storage, data):
    if path.is_symlink():
        fail(str(path) + ' must not be a symlink')
    if path.exists() and not path.is_dir():
        fail(str(path) + ' must be a directory')
if data.exists() and any(data.iterdir()) and (data.stat().st_uid != uid or
        data.stat().st_gid != gid or stat.S_IMODE(data.stat().st_mode) != 0o700):
    fail(str(data) + ' must be owned by ' + user + ' with mode 700; existing files were not changed')
repair_storage = False
if storage.exists():
    info = storage.stat()
    search_bit = 0o100 if info.st_uid == uid else (0o010 if info.st_gid == gid else 0o001)
    if not info.st_mode & search_bit:
        if any(p != data or not p.is_dir() or p.is_symlink() or any(p.iterdir()) for p in storage.iterdir()):
            fail(str(storage) + ' is not accessible to ' + user + '; existing files were not changed')
        repair_storage = True
db = data / 'data.db'
if (not db.exists() or db.stat().st_size == 0) and not (env.get('ADMIN_EMAIL') and env.get('ADMIN_PASSWORD')):
    fail('set ADMIN_EMAIL and ADMIN_PASSWORD in .env for the first launch')
if repair_storage:
    os.chown(storage, uid, gid)
    storage.chmod(0o700)
for path in (storage, data):
    if not path.exists():
        path.mkdir(mode=0o700, parents=True)
        os.chown(path, uid, gid)
if not any(data.iterdir()):
    os.chown(data, uid, gid)
    data.chmod(0o700)
print('Persistent storage:', storage)
print('Browser address:', ', '.join(o.strip() for o in origins))
PY

# Build before replacing the running API. Compose V2 handles legacy Compose labels.
"${COMPOSE[@]}" build api
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 120 api
"${COMPOSE[@]}" ps api
