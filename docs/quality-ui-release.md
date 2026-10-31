# Quality: подготовка обновления и отката

Подготовленный выпуск основан на GitHub `bfa96bff8e658acb43cf62bc0a8fc7e95b194e4b`. Рабочий сервер в этой задаче не обновлялся. Его `/api/health` 31 октября ответил HTTP 200 (`ok: true`); это проверка доступности прежней установленной версии, а не проверка выпуска. Перед обновлением требуется резервная копия **на самом сервере**; локальная синтетическая копия её не заменяет.

## Что входит

- Общая аналитика с экспортом CSV/PDF и общими фильтрами; Dashboard остаётся отдельным.
- «Управление»: сотрудники, аккаунты, назначение тимлидера и системные настройки.
- Просмотр своей и других команд тимлидером с защищёнными материалами, без права менять чужие оценки/апелляции.
- Счётчики незавершённой работы по роли и назначению.
- Исправления ошибок, найденных при QA: адаптивные формы, диалоги, несохранённые правки, повторные запросы, восстановление загрузки страницы, карточка назначенного звонка и календарный месяц Баку.

Существующие `.env`, учётные записи, пароли, идентификаторы и связи источников не заменяются. Старые ссылки `/agents` и `/reports` перенаправляются. Прежние хешированные JS/CSS оставлены в выпуске для уже открытых вкладок.

## Исправление назначения команды и записи (31 октября)

В «Управление → Сотрудники» у оператора появилась отдельная кнопка «Назначить тимлидера» / «Изменить тимлидера». Она меняет только состав команды, включая профили без аккаунта. Пароли и учётные записи не затрагиваются.

Воспроизведение в жалобах и материалах тимлидера использует общий кэш Calls: после удаления временного файла запись восстанавливается через HTTP. Проверки доступа до и после загрузки сохранены. Ошибка плеера теперь объясняется текстом и допускает повторную загрузку. AI-генерация этим выпуском не добавляется и не включается.

## Читаемость страниц оценок (31 октября)

На основе опубликованной версии `31b6f7512d4f188e1961b9cf6e62bdcdda453134` обновлены «Моя группа» и «Мои оценки»: адаптивные критерии без наложения подписей, компактные карточки и график, раскрываемая детализация по дням. Эта правка меняет только frontend; серверные файлы и конфигурация совпадают с указанной версией.

## Обновление

Выполнять из каталога репозитория сервера. Сначала убедиться, что `git status --short` не показывает собственных изменений. Не использовать `reset --hard`.

1. Сохранить текущий commit: `git rev-parse HEAD`. Затем `git pull --ff-only`.
2. Проверить текущие параметры Compose, не выводя секреты: имя проекта (обычно `quality`), путь хранилища `QUALITY_STORAGE_DIR` (обычно `/var/lib/agentscore-storage`), UID/GID процесса. Если они переопределены, использовать реальные значения во всех командах ниже.
3. Сохранить **образ работающего контейнера**, а не произвольный старый тег:

   ```bash
   QA_CONTAINER=$(sudo docker compose -p quality --env-file .env -f compose.yaml ps -q api)
   test -n "$QA_CONTAINER"
   QA_OLD_IMAGE=$(sudo docker inspect --format '{{.Image}}' "$QA_CONTAINER")
   sudo docker image tag "$QA_OLD_IMAGE" quality-server:before-ui-update
   sudo docker compose -p quality --env-file .env -f compose.yaml build api
   ```

4. Остановить запись и сделать копию. Для стандартного пути хранилища:

   ```bash
   QA_BACKUP="/var/backups/quality-ui-$(date +%Y%m%d-%H%M%S)"
   sudo docker compose -p quality --env-file .env -f compose.yaml stop api
   sudo python3 scripts/backup_data.py backup \
     --source /var/lib/agentscore-storage/data --destination "$QA_BACKUP" --offline
   ```

   Продолжать только после успешного завершения backup. Записать `QA_BACKUP` и прежний UID/GID каталога данных: `sudo stat -c '%u:%g' /var/lib/agentscore-storage/data`. При ошибке backup запустить прежний контейнер командой `docker compose ... start api`; новую версию пока не запускать.

5. Запустить готовый образ:

   ```bash
   sudo docker compose -p quality --env-file .env -f compose.yaml up -d --no-build --wait --wait-timeout 120 api
   sudo docker compose -p quality --env-file .env -f compose.yaml ps api
   curl --fail http://192.168.68.41:8787/api/health
   git rev-parse HEAD
   ```

   Подтвердить, что контейнер использует именно опубликованные файлы (ожидается `Verified 131 runtime files`):

   ```bash
   sudo docker compose -p quality --env-file .env -f compose.yaml exec -T api node -e '
   const fs=require("node:fs"),crypto=require("node:crypto");
   const manifest=JSON.parse(fs.readFileSync(0,"utf8"));
   for(const [path,expected] of Object.entries(manifest)) {
     const actual=crypto.createHash("sha256").update(fs.readFileSync("/app/"+path)).digest("hex");
     if(actual!==expected) throw Error("Runtime mismatch: "+path);
   }
   console.log("Verified "+Object.keys(manifest).length+" runtime files");
   ' < docs/quality-ui-runtime-sha256.json
   ```

   Отдельно проверить Brave: вход, «Управление», назначение команды, аналитика/экспорт, счётчики, доступ тимлидера и существующая жалоба. Healthcheck сам по себе этого не подтверждает. Внешние HTTP-источники и Jira проверяются в серверном окружении; Jira — только чтение.

## Откат

Не ограничиваться переключением Git: новая версия могла выполнить миграции или записать данные. Остановить API. Сохранить текущий каталог данных под новым именем, затем восстановить backup **в отсутствующий** `/var/lib/agentscore-storage/data`:

```bash
sudo docker compose -p quality --env-file .env -f compose.yaml stop api
sudo mv /var/lib/agentscore-storage/data "/var/lib/agentscore-storage/data-after-update-$(date +%Y%m%d-%H%M%S)"
sudo python3 scripts/backup_data.py restore --source "$QA_BACKUP" \
  --destination /var/lib/agentscore-storage/data --offline
```

Вернуть сохранённый UID/GID восстановленному каталогу и файлам (`chown -R` только на восстановленном `data`), права корневого каталога — `700`. Затем:

```bash
sudo docker image tag quality-server:before-ui-update quality-server:local
sudo docker compose -p quality --env-file .env -f compose.yaml up -d --no-build --wait --wait-timeout 120 api
```

Сохранённый каталог `data-after-update-*` не удалять: в нём могут быть записи после обновления. Восстановление backup откатывает данные к моменту копии. Проверить вход, оценки и материалы после отката.

## Временный пароль

Массовое создание первой партии сохраняет отчёт `<DATA_DIR>/private/user-provision-*.json`, поле `temporary_password`, с `must_change_password: true`. Значение генерируется, постоянного общего пароля в исходниках нет. Сам серверный отчёт в доступной локальной копии не найден; реальные пароли не сбрасывались. Не запускать provision повторно ради получения пароля. Обязательная смена проверена на отдельном синтетическом аккаунте.

## Проверенные границы

Сборка Docker и вход четырёх ролей проверены на новой синтетической базе. Backup и restore существующим скриптом также проверены на остановленной синтетической базе. Команды обновления **рабочего** сервера выше подготовлены для оператора, но в этой задаче не выполнялись. Подробный отчёт: [quality-ui-qa-coverage.md](quality-ui-qa-coverage.md).
