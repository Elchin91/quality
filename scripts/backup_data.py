#!/usr/bin/env python3
"""Consistent, checked database/upload backup and restore; no application imports."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from math import isfinite
from zoneinfo import ZoneInfo


BAKU = ZoneInfo('Asia/Baku')


def valid_call_interval(started_at, ended_at, baku_date, duration_seconds):
    if (not isinstance(started_at, str) or not isinstance(ended_at, str)
            or not isinstance(baku_date, str)
            or not isinstance(duration_seconds, (int, float))
            or not isfinite(duration_seconds)):
        return 0
    try:
        started = datetime.strptime(started_at, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
        ended = datetime.strptime(ended_at, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
        canonical_started = started.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        canonical_ended = ended.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        duration = (ended - started).total_seconds()
        return int(canonical_started == started_at and canonical_ended == ended_at
                   and duration >= 0 and duration == duration_seconds
                   and started.astimezone(BAKU).date().isoformat() == baku_date)
    except (TypeError, ValueError, OverflowError):
        return 0


def register_sqlite_validation_functions(connection):
    connection.create_function('call_qa_valid_interval', 4, valid_call_interval,
                               deterministic=True)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked_db(path):
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    register_sqlite_validation_functions(connection)
    if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        connection.close()
        raise ValueError('SQLite integrity check failed')
    if connection.execute('PRAGMA foreign_key_check').fetchall():
        connection.close()
        raise ValueError('SQLite foreign key check failed')
    if connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='call_source_records'"
    ).fetchone() and connection.execute('''
            SELECT 1 FROM call_source_records
             WHERE call_qa_valid_interval(call_started_at_utc,call_ended_at_utc,
                                          baku_date,duration_seconds)<>1
             LIMIT 1
    ''').fetchone():
        connection.close()
        raise ValueError('SQLite call interval integrity check failed')
    return connection


def ready_recordings(db):
    """Check the application link that SQLite cannot enforce as a foreign key."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='call_source_records'").fetchone():
        return {}
    recordings = {}
    rows = db.execute('''
        SELECT source.recording_storage_key, source.recording_mime_type,
               source.recording_size_bytes, upload.id, upload.filename,
               upload.type, upload.size, upload.mime
        FROM call_source_records source
        LEFT JOIN uploads upload ON upload.id=source.recording_storage_key
        WHERE source.recording_status='ready'
    ''')
    for key, mime, size, upload_id, filename, kind, upload_size, upload_mime in rows:
        match = re.fullmatch(r'call-recording:([a-f0-9]{64})', key or '')
        if (not match or upload_id != key or filename != match.group(1) + '.audio'
                or kind != 'call' or not isinstance(size, int) or size < 0
                or upload_size != size or not mime or upload_mime != mime):
            raise ValueError('ready call recording has missing or inconsistent upload metadata')
        recordings[key] = (match.group(1), size)
    return recordings


def check_recording_file(recordings, upload_id, relative, path):
    if upload_id not in recordings:
        return
    sha, size = recordings[upload_id]
    if (Path(relative).as_posix() != f'uploads/call-recordings/{sha}.audio'
            or path.stat().st_size != size or digest(path) != sha):
        raise ValueError('ready call recording path, size or content hash is inconsistent')


def evicted_recordings(db, recordings):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='call_recording_cache'").fetchone():
        return set()
    rows = db.execute('SELECT upload_id,state FROM call_recording_cache').fetchall()
    if any(state not in ('present', 'evicted') for _, state in rows):
        raise ValueError('recording cache recovery must finish before backup')
    evicted = {key for key, state in rows if state == 'evicted'}
    if not evicted.issubset(recordings):
        raise ValueError('evicted call recording has no verified source')
    return evicted


def absent_recording(base, relative, key, recordings):
    expected = f'uploads/call-recordings/{recordings[key][0]}.audio'
    if relative != expected:
        raise ValueError('evicted call recording mapping is invalid')
    candidate = base / relative
    if candidate.exists() or any(p.is_symlink() for p in [candidate, *candidate.parents] if p != base.parent):
        raise ValueError('evicted call recording cache state is inconsistent')


def safe_file(base, relative):
    rel = Path(relative)
    if rel.is_absolute() or '..' in rel.parts:
        raise ValueError('unsafe backup path')
    candidate = base / rel
    if any(p.is_symlink() for p in [candidate, *candidate.parents] if p != base.parent):
        raise ValueError('symlinks are not allowed')
    if not candidate.is_file() or not candidate.resolve().is_relative_to(base.resolve()):
        raise ValueError('missing or unsafe backup file')
    return candidate


def upload_files(base):
    """Preserve historical unindexed media without creating application rows."""
    root = base / 'uploads'
    if not root.exists() and not root.is_symlink():
        return {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('unsafe uploads directory or symlink')
    files = {}
    for candidate in root.rglob('*'):
        if candidate.is_symlink():
            raise ValueError('upload symlinks are forbidden')
        if candidate.is_file():
            relative = candidate.relative_to(base).as_posix()
            files[relative] = digest(safe_file(base, relative))
        elif not candidate.is_dir():
            raise ValueError('non-regular upload files are forbidden')
    return files


def calibration_files(base):
    """Only manifest-tracked, immutable local calibration workspaces are durable."""
    root = base / 'calibration'
    if not root.exists() and not root.is_symlink():
        return {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('unsafe calibration directory')
    files = {}
    for workspace in root.iterdir():
        if (not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', workspace.name)
                or workspace.is_symlink() or not workspace.is_dir()):
            raise ValueError('unsafe or unfinished calibration workspace; stop CLI writers first')
        manifest_path = safe_file(base, workspace.relative_to(base) / 'manifest.json')
        if manifest_path.stat().st_size > 1024 * 1024:
            raise ValueError('calibration manifest size limit')
        manifest = json.loads(manifest_path.read_text())
        entries = manifest.get('files')
        if (manifest.get('format') != 1 or not isinstance(entries, dict)
                or not {'dataset.json', 'annotations.json', 'secret.key'} <= set(entries)
                or len(entries) > 10000):
            raise ValueError('invalid calibration manifest')
        expected = {'manifest.json', *entries}
        actual = set()
        for candidate in workspace.rglob('*'):
            if candidate.is_symlink():
                raise ValueError('calibration symlinks are forbidden')
            if candidate.is_file():
                actual.add(candidate.relative_to(workspace).as_posix())
        if expected != actual:
            raise ValueError('untracked calibration files or active writer; import annotations and stop CLI writers first')
        files[manifest_path.relative_to(base).as_posix()] = digest(manifest_path)
        for relative, checksum in entries.items():
            if not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum):
                raise ValueError('invalid calibration checksum')
            source = safe_file(workspace, relative)
            if source.stat().st_size > 64 * 1024 * 1024 or digest(source) != checksum:
                raise ValueError('calibration checksum mismatch; use validated imports')
            files[source.relative_to(base).as_posix()] = checksum
    return files


def backup(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if destination.exists() or destination.is_relative_to(source):
        raise ValueError('backup destination must be new and outside DATA_DIR')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.quality-backup-', dir=destination.parent))
    db = None
    try:
        db = checked_db(source / 'data.db')
        version = db.execute('PRAGMA data_version').fetchone()[0]
        with sqlite3.connect(stage / 'data.db') as snapshot:
            db.backup(snapshot)
        snap = checked_db(stage / 'data.db')
        try:
            recordings = ready_recordings(snap)
            evicted = evicted_recordings(snap, recordings)
            uploads = snap.execute('SELECT id, path, size FROM uploads').fetchall()
            tables = [r[0] for r in snap.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            counts = {t: snap.execute('SELECT count(*) FROM "' + t.replace('"', '""') + '"').fetchone()[0] for t in tables}
        finally:
            snap.close()
        calibration = calibration_files(source)
        for relative in calibration:
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_file(source, relative), target)
        if calibration_files(stage) != calibration:
            raise ValueError('calibration changed during backup; stop CLI writers and retry')
        media_inventory = upload_files(source)
        for relative in media_inventory:
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_file(source, relative), target)
        if upload_files(stage) != media_inventory:
            raise ValueError('uploads changed during backup; stop writers and retry')
        paths = {}
        for upload_id, stored, expected_size in uploads:
            original = Path(stored)
            if upload_id in evicted:
                relative = f'uploads/call-recordings/{recordings[upload_id][0]}.audio'
                if original.name != Path(relative).name or original.parent.name != 'call-recordings':
                    raise ValueError('evicted call recording path is invalid')
                absent_recording(source, relative, upload_id, recordings)
                paths[upload_id] = relative
                continue
            if not original.is_absolute():
                original = source / original
            try:
                relative = original.relative_to(source)
            except ValueError:
                # Older installations can retain absolute paths from another host.
                # Accept only one matching file inside the staged uploads tree.
                matches = [Path(name) for name in media_inventory
                           if Path(name).name == original.name
                           and (source / name).stat().st_size == expected_size]
                if len(matches) != 1:
                    raise ValueError('historical upload path cannot be safely resolved')
                relative = matches[0]
            if relative.parts[0] != 'uploads':
                raise ValueError('upload is outside DATA_DIR/uploads')
            original = safe_file(source, relative)
            target = safe_file(stage, relative)
            check_recording_file(recordings, upload_id, relative, target)
            paths[upload_id] = relative.as_posix()
        if db.execute('PRAGMA data_version').fetchone()[0] != version:
            raise ValueError('database changed during backup; stop writers and retry')
        if upload_files(source) != media_inventory:
            raise ValueError('uploads changed during backup; stop writers and retry')
        if calibration_files(source) != calibration:
            raise ValueError('calibration changed during backup; stop CLI writers and retry')
        files = {p.relative_to(stage).as_posix(): digest(p) for p in stage.rglob('*') if p.is_file()}
        manifest = {'format': 2 if evicted else 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'files': files, 'upload_paths': paths, 'row_counts': counts,
                    'evicted_uploads': sorted(evicted)}
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        for p in stage.rglob('*'):
            p.chmod(0o700 if p.is_dir() else 0o600)
        stage.rename(destination)
    finally:
        if db is not None:
            db.close()
        if stage.exists():
            shutil.rmtree(stage)


def restore(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if destination.exists() or destination.is_relative_to(source):
        raise ValueError('restore destination must be new; never overwrite live data')
    manifest = json.loads(safe_file(source, 'manifest.json').read_text())
    if manifest.get('format') not in (1, 2) or 'data.db' not in manifest['files']:
        raise ValueError('unsupported backup format')
    for rel, expected in manifest['files'].items():
        if digest(safe_file(source, rel)) != expected:
            raise ValueError('backup checksum mismatch')
    calibration = calibration_files(source)
    if any(relative not in manifest['files'] for relative in calibration):
        raise ValueError('backup calibration mapping is incomplete')
    db = checked_db(source / 'data.db')
    try:
        recordings = ready_recordings(db)
        evicted = evicted_recordings(db, recordings)
        upload_ids = {row[0] for row in db.execute('SELECT id FROM uploads')}
    finally:
        db.close()
    mappings = manifest.get('upload_paths')
    if manifest.get('evicted_uploads', []) != sorted(evicted):
        raise ValueError('backup evicted recording mapping is incomplete')
    if not isinstance(mappings, dict) or set(mappings) != upload_ids:
        raise ValueError('backup upload mapping is incomplete')
    for upload_id, relative in mappings.items():
        if upload_id in evicted:
            absent_recording(source, relative, upload_id, recordings)
            continue
        rel = Path(relative)
        if not rel.parts or rel.parts[0] != 'uploads' or relative not in manifest['files']:
            raise ValueError('unsafe backup upload mapping')
        safe_file(source, relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.quality-restore-', dir=destination.parent))
    try:
        for rel in manifest['files']:
            target = stage / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_file(source, rel), target)
        if calibration_files(stage) != calibration:
            raise ValueError('restored calibration checksum mismatch')
        (stage / 'uploads').mkdir(exist_ok=True)
        with sqlite3.connect(stage / 'data.db') as db:
            for upload_id, rel in manifest['upload_paths'].items():
                if upload_id in evicted:
                    absent_recording(stage, rel, upload_id, recordings)
                else:
                    media = safe_file(stage, rel)
                    check_recording_file(recordings, upload_id, rel, media)
                db.execute('UPDATE uploads SET path = ? WHERE id = ?', (str(destination / rel), upload_id))
            for upload_id, stored in db.execute('SELECT id, path FROM uploads'):
                if stored != str(destination / mappings[upload_id]):
                    raise ValueError('restored upload path mismatch')
            for table, expected in manifest['row_counts'].items():
                count = db.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0]
                if count != expected:
                    raise ValueError('restored row count mismatch')
        check = checked_db(stage / 'data.db')
        check.close()
        for p in stage.rglob('*'):
            p.chmod(0o700 if p.is_dir() else 0o600)
        stage.rename(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'restore'])
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    parser.add_argument('--offline', action='store_true', help='confirm application writers have been stopped')
    args = parser.parse_args()
    if not args.offline:
        parser.error('--offline is required: stop application writers first')
    os.umask(0o077)
    {'backup': backup, 'restore': restore}[args.action](args.source, args.destination)
    print(f'{args.action} verified: {args.destination}')


if __name__ == '__main__':
    main()
