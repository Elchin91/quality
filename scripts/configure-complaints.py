#!/usr/bin/env python3
"""Configure Jira complaints on the deployment host without putting a PAT in Git."""
import argparse
import getpass
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import Callable
import warnings


class ConfigurationError(Exception):
    """Contains only a safe, user-facing message."""


KEY = re.compile(r'^[ \t]*(?:export[ \t]+)?(JIRA_TOKEN|COMPLAINTS_ENABLED)[ \t]*=(.*)$')
TOKEN = re.compile(r'[A-Za-z0-9._~+/=:\-]{1,4096}\Z')


def parse_token(raw: str) -> str:
    value = raw.strip()
    if value.startswith(('"', "'")):
        quote = value[0]
        end = value.find(quote, 1)
        if end < 0 or (value[end + 1:].strip() and not value[end + 1:].lstrip().startswith('#')):
            raise ConfigurationError('Некорректная строка JIRA_TOKEN в .env; значение не изменено.')
        value = value[1:end]
    else:
        value = value.split('#', 1)[0].strip()
    if value and not TOKEN.fullmatch(value):
        raise ConfigurationError('Некорректный формат JIRA_TOKEN; значение не изменено.')
    return value


def configure(env_file: Path, prompt: Callable[[str], str] = getpass.getpass) -> bool:
    """Preserve existing credentials; return True only when the file was replaced."""
    try:
        fd = os.open(env_file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK)
    except OSError as error:
        raise ConfigurationError('Не удалось открыть обычный файл .env. Проверьте путь и права.') from error
    with os.fdopen(fd, 'r', encoding='utf-8', newline='') as source:
        original = os.fstat(source.fileno())
        if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1:
            raise ConfigurationError('.env должен быть обычным файлом без дополнительных ссылок.')
        if original.st_size > 1_048_576:
            raise ConfigurationError('Файл .env превышает допустимый размер; настройки не изменены.')
        before = source.read()
    lines = before.splitlines(keepends=True)
    matches = [(i, KEY.match(line.rstrip('\r\n'))) for i, line in enumerate(lines)]
    token_lines = [(i, match) for i, match in matches if match and match[1] == 'JIRA_TOKEN']
    if len(token_lines) > 1:
        raise ConfigurationError('В .env несколько строк JIRA_TOKEN. Оставьте одну и повторите команду.')
    token = parse_token(token_lines[0][1][2]) if token_lines else ''
    if not token:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                token = prompt('Jira PAT (ввод скрыт): ')
        except (EOFError, KeyboardInterrupt, getpass.GetPassWarning) as error:
            raise ConfigurationError('Настройка отменена. Для скрытого ввода запустите команду в терминале.') from error
        if not TOKEN.fullmatch(token):
            raise ConfigurationError('Токен пустой или имеет неверный формат; .env не изменён.')
    output = []
    enabled_written = False
    for line in lines:
        match = KEY.match(line.rstrip('\r\n'))
        if match and match[1] == 'COMPLAINTS_ENABLED':
            if not enabled_written:
                output.append('COMPLAINTS_ENABLED=true\n')
                enabled_written = True
        elif match and match[1] == 'JIRA_TOKEN' and not parse_token(match[2]):
            output.append('JIRA_TOKEN=' + token + '\n')
        else:
            output.append(line)
    after = ''.join(output)
    if not token_lines or not enabled_written:
        if after and not after.endswith(('\n', '\r')):
            after += '\n'
        if not token_lines:
            after += 'JIRA_TOKEN=' + token + '\n'
        if not enabled_written:
            after += 'COMPLAINTS_ENABLED=true\n'
    if after == before and stat.S_IMODE(original.st_mode) == 0o600:
        return False
    name = None
    try:
        target_fd, name = tempfile.mkstemp(prefix='.env-complaints-', dir=env_file.parent)
        with os.fdopen(target_fd, 'w', encoding='utf-8', newline='') as target:
            os.fchmod(target.fileno(), 0o600)
            if os.geteuid() == 0:
                os.fchown(target.fileno(), original.st_uid, original.st_gid)
            target.write(after)
            target.flush()
            os.fsync(target.fileno())
        current = env_file.lstat()
        if (current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size) != (
                original.st_dev, original.st_ino, original.st_mtime_ns, original.st_size):
            raise ConfigurationError('.env изменился во время настройки. Повторите команду.')
        os.replace(name, env_file)
    finally:
        if name is not None and os.path.exists(name):
            os.unlink(name)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description='Настроить импорт жалоб Jira; PAT вводится скрыто.')
    parser.add_argument('--env-file', type=Path,
                        default=Path(__file__).resolve().parent.parent / '.env')
    args = parser.parse_args()
    try:
        configure(args.env_file)
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print('Не удалось сохранить настройки. Проверьте файл .env и права доступа.', file=sys.stderr)
        return 1
    print('Жалобы настроены: COMPLAINTS_ENABLED=true. Токен хранится только в серверном .env.')
    print('Для применения выполните: sudo bash scripts/start-server.sh')
    return 0


if __name__ == '__main__':
    sys.exit(main())
