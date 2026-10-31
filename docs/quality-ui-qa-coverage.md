# Реестр QA интерфейса Quality

Дата: 31 октября 2026. Основание: маршруты приложения, `tests/e2e/*.spec.ts` и сохранённые результаты запусков. Реестр различает выполненные действия, осмотр экранов и непроверенные условия; он не утверждает, что проверена каждая кнопка.

## Статус выполнения

| Свидетельство | Что подтверждает | Ограничение |
| --- | --- | --- |
| `.runtime/qa-e2e/functional-release-before-retries/results.json` | Основной функциональный запуск: **79 сценариев, 74 passed, 5 failed**, без skipped/flaky | Сбои: два сценария Admin appeals, назначение звонка, восстановление page module и assistant SSE |
| `/tmp/quality-ui-retries.log` | После исправлений: **8/8 passed**, включая все пять ранее неуспешных сценариев | Повтор также охватывает две ранее успешные ручные операции назначения и Preferences. Это отдельный выборочный запуск, не новый полный 79/79 |
| `.runtime/qa-e2e/matrix-final/results.json` | **72/72 passed**, финальная сборка: 4 роли × RU/EN/AZ × light/dark × 3 режима размера | Проверки выполнялись после загрузки данных и стабилизации размеров; масштаб 200% представлен CSS reflow, не изменением browser zoom |
| `.runtime/qa-e2e/automation-final/results.json` | **2/2 passed**: расписание, Enable/Run/Disable для звонков и чатов | Реальная локальная очередь; отсутствие настроенного source честно завершает задание ошибкой, успешный внешний подбор не заявляется |
| Текущий `.runtime/qa-e2e/results.json` | Может быть перезаписан командой `--list` | `expected: 0` и `skipped` из списка тестов не являются результатом исполнения. Имя каталога `final` также не доказывает успешность |

Все 79 уникальных функциональных сценариев имеют успешное выполнение в основном или выборочном запуске. Складывать 74 и 8 нельзя: три сценария повторяются. `auth-recovery`, `appeal-form-guards`, пять history/score actions, три local complaint evidence и семь navigation-counts прошли в основном архиве. Автоматика: ещё два отдельных успешных сценария. Финальная матрица 72/72 завершена. Дополнительные 16 проходов ширин 375/768/1366/1440 прошли в более раннем архиве; в реестре указано их происхождение, они не выдаются за повтор на финальной сборке.

## Поэлементный реестр

[Открыть интерактивный HTML](qa-interface-registry/interface-registry.html) · [JSON](qa-interface-registry/interface-registry.json).

Реестр содержит 1535 уникальных записей элементов (переводы и контексты разделены), 12217 наблюдений, 306 проверок экранов/вкладок/прокрутки и 97 результатов сценариев. Для каждого наблюдения сохранены роль, экран, панель, условия и исходный запуск. Есть фильтры роли, статуса и текста. **Inventory-only означает, что факт действия именно над этим элементом отдельно не доказан; этот статус не считается успехом.** Функциональные сценарии приведены отдельно, автоматической привязки к каждой кнопке нет. Поэтому абсолютная проверка каждого элемента во всех состояниях этим отчётом не заявляется.

## Как читать карту

- **Inventory**: экран открыт, видимые элементы перечислены. Это не проверка выполнения действия каждой кнопки.
- **Action**: сценарий нажимает элемент, меняет значение или отправляет запрос и проверяет результат. Наличие сценария не заменяет статус его последнего запуска.
- **Backend**: реальный локальный HTTP API и отдельная синтетическая SQLite-база, созданная в `/tmp/quality-e2e-*`; не рабочая база пользователей.
- **HTTP mock**: ответ, ошибка, задержка или поток подменяются Playwright. Подтверждается поведение интерфейса, а не работа внешней службы.
- **Seed**: исходные задания, записи и AI-черновики подготовлены заранее; этап их получения/генерации не проверяется.

Исходники и тесты хранятся в рабочем проекте Quality; этот GitHub-репозиторий содержит готовую сборку. Имена файлов ниже являются ссылками на исходный проект, а не файлами этого build-only репозитория. Общие источники маршрутов: `App.tsx`, `маршруты чатов`, `маршруты звонков`. Набор экранов для обхода определён в `helpers.ts`. `/agents` перенаправляет на `/settings?tab=staff`, `/reports` — на `/analytics?tab=export`.

## Экраны и действия по ролям

Идентификаторы тестов раскрыты в следующем разделе. В колонке «Action» перечислены именно действия из сценариев, а не все возможности экрана.

| Роль | Экраны | Inventory / Action в сценариях | Тесты и граница доказательства |
| --- | --- | --- | --- |
| Все роли | `/login`, выход через меню Account | Action: реальный вход/выход каждой роли; домен, регистрация, ошибочный пароль и повтор; скрытие защищённой навигации после отзыва сессии | L1, A3, N2; Backend, HTTP mock одной ошибки входа |
| Все роли с временным паролем | `/change-password` | Action: отказ защищённого API до смены; слабый/несовпадающий пароль, успешная смена и доступ после неё | A1; Backend, специально созданный пользователь |
| Все роли | Header, Sidebar, `/settings` → Preferences | Action: переходы меню; RU/EN/AZ, light/dark, сохранение предпочтений после reload; Escape и возврат фокуса выпадающего списка; счётчики доступных заданий | L1, P1, N1; Backend/localStorage. Администратор видит Management, остальные — только Preferences |
| Admin | Ошибка загрузки страницы `/admin/chat-qa` | Action: HTTP abort JS chunk → error boundary → Try again → рабочий экран и исходный URL | R1; HTTP mock одной ошибки модуля, затем реальная локальная загрузка; пройдено в retries |
| Admin | `/`, `/dashboard` | `/dashboard`: Inventory, прокрутка, навигация и счётчики | L1, L2, N1. Полный маршрут `/` и каждое действие графиков отдельно не проверяются |
| Admin | `/evaluations` | Action: фильтры сотрудника/классификатора/балла, URL и reload; карточка; точная выборка из аналитики; длинное имя; Cancel удаления, pending disable, 503 → повтор Delete → API 404 и reload | A2, E1, D1, H3; Backend, HTTP mock первого удаления. Удалена только отдельная synthetic evaluation |
| Admin | `/analytics`, `/reports` → Export | Action: вкладки и общие URL-фильтры, переход к деталям; CSV/PDF и сравнение строк/дат/баллов с API; отмена, ошибка следующей страницы, повтор без частичного файла | A2, E1, E2; Backend для успешного экспорта, HTTP mock для сбоев/отмены |
| Admin | `/settings?tab=staff`, `/agents` | Action: поиск, роль/статус/руководитель, страницы; новая учётная запись; создание доступа для существующего профиля; имя/руководитель; отмена; деактивация; сохранение ID и reload | S1, A1, D1; Backend. Существующие рабочие аккаунты/пароли не меняются |
| Admin | `/settings?tab=system` | Action: неверный Host, выбор Model, Save и reload, возврат исходной настройки | C1; Backend настроек, HTTP mock списка моделей. Связность с модельным сервером не подтверждается |
| Admin | `/admin/chat-qa` | Action: неверный период каталога/Reset; обязательные поля Reassign/Cancel; подтверждение/отклонение mappings; реальное переназначение и отмена отдельного задания; границы чисел политики | C2, C3, M1; Backend. Диалоговый inventory предложенных mappings также использует HTTP mock |
| Admin | `/admin/call-qa` | Action: направление/пригодность/Reset каталога; границы длительности/deadline; назначение и отмена подготовленного звонка, рост версии и reload | C2, C3, M1; Backend, Seed звонка. Новая загрузка записи из внешнего Calls не проверяется |
| Admin | Chat/Call → Automatic assignment | Action: повтор статуса после 503, отказ неверного CSV, валидный CSV, Enable/Run/Disable и сохранение после reload | C2 и C4 пройдены. Backend, ошибка статуса — HTTP mock; внешние sources отключены |
| Admin | `/appeals` | Action: Active/History/All, оператор/статус, страницы и сброс деталей; обязательный rationale; Approve as admin при отсутствии lead; Assign reviewer для pending_assignment; reload и сохранность исходной оценки | A4; Backend, два сценария прошли в retries после исправления. Это не все возможные состояния апелляции |
| Admin, Reviewer | `/complaints`, `/complaints/:id` | Action: поиск/страницы, другой номер, отказ sources, attribution/conclusion/Save/reload/conflict; reassignment; linking существующей chat evaluation и call task, readonly evidence, scoped OGG; clipboard, Jira popup; запрет завершения незаконченной оценки, затем `evaluated`/reload без дубля | Q1, Q3, N2; Backend + Seed локальных кандидатов. Jira popup — HTTP mock GET; upstream не вызывается. Новая дополнительная оценка проверена только на отказ `recording_not_ready` без partial task |
| Reviewer | `/qa/dashboard` | Inventory, счётчики незавершённых работ | L1, L2, N1. Переключатели периодов и повтор ошибки статистики не имеют отдельного action-E2E |
| Reviewer | `/qa/chats`, `/qa/chats/:id` | Action: поиск по длинной переписке, прокрутка, Start review, thumbs, обязательный общий/критериальный комментарий, Publish, reload/read-only; сохранение введённого текста при focus-refresh | J1, W1; Backend/Seed, задержка auth/me в W1 подменяется |
| Reviewer | `/qa/calls`, `/qa/calls/:id` | Action: Load recording, реальный синтетический OGG, Play/Pause/seek/speed; Start, thumbs/TAQ, обязательный комментарий, Complete/reload; адаптивная раскладка и открытие редактирования сегмента | J1, W1; Backend/Seed аудио; transcript-quality в W1 — HTTP mock |
| Reviewer | Оценки с AI-предупреждением | Action: Apply AI draft для звонка, блокировка публикации, переход/фокус к acknowledgement, ручное подтверждение, реальное завершение и проверка provenance | G1; Backend + Seed AI-ответа. Модель ничего не генерирует во время этого сценария |
| Reviewer | `/appeals/reviewer`, `/appeals/reviewer/:id` | Action: получение назначенной апелляции, изменение оценки и rationale, завершение и отображение решения оператору | J2; Backend, историческая шкала M10. Отдельные v2 и dirty-guard проверки есть в unit-тестах, не заменяют action-E2E |
| Reviewer | `/notifications` | Action: Mark read, искусственный 503, безопасная ошибка, Try again, уменьшение unread, reload | N3; Backend с одной HTTP-подменой; пройдено в основном архиве |
| Admin, Reviewer | `/checklist` | Action: три вкладки, Enter по сфокусированным tabs, прокрутка до конца; Inventory содержимого | D1, L1, L2. Полный сценарий стрелочной клавиатурной навигации и ручной screen-reader аудит отсутствуют |
| Admin, Reviewer | `/ask-ai` | Action: пустой запрос, 503, текст synthetic SSE, Enter, Stop, reload истории, Clear | P2; HTTP mock генерации. CARE retrieval/локальная модель/качество ответа не подтверждаются |
| Agent | `/me` | Action: значения Total/This Month сверены с API, Next/Previous на 28 оценках, переход в конкретную оценку; видимость 30-Day Trend | H2; Backend. Переключателей периода на этом экране нет. Граница календарного месяца исправлена и отдельно проверена API-тестом |
| Agent | `/me/evaluations/:id` | Action: Acknowledge/Dispute templates, комментарий 503 → повтор → единственная запись/reload/отсутствие в другой оценке; право на апелляцию, reason, отправка, Cancel/Escape и pending double-submit | H2, J2, F1; Backend успешного комментария и полной цепочки апелляции; HTTP mock ошибок |
| Agent | `/me/appeals` | Action: отображение отправленной апелляции и итогов одобрения/отказа | J2; Backend |
| Team lead | `/team` | Action: своя/другая команда, Channel, reload scope, детали call/chat, воспроизведение материала, отсутствие кнопок изменения при чужой команде | T1, D1; Backend, подготовленные синтетические записи |
| Team lead | `/appeals/lead` | Action: Approve; Reject только с rationale; результат виден оператору | J2; Backend. Защита локального текста имеет unit-проверку, отдельный браузерный Back/Forward здесь не выполняется |
| Agent, Team lead, Reviewer | `/history` | Action для каждой роли: собственные 28 imported records, Next/Previous, включительные From/To, сброс offset, карточка summary/notes без Save/Delete/Publish, отказ недоступной записи | H1; Backend + Seed полноценных import receipts, 3/3 пройдено |
| Agent, Team lead | `/notifications` | Inventory и обычный доступ к странице | L1, L2. Повтор Mark read отдельно реализован для Reviewer, не каждой роли |

## Имена сценариев и источники

В таблице используются точные имена тестов либо явно указанные шаблоны генерируемых тестов. Ни один новый сценарий не получает статус passed только из-за наличия в этом списке.

| ID | Файл и имя сценария |
| --- | --- |
| L1 | `roles-layout.spec.ts`: `${role}: actual login and logout`; `${role}: routes, controls and scrolling at ${width}px`; `${role}: navigation links, language and theme`; `${role}: automated accessibility of entry screen` |
| L2 | `interface-matrix.spec.ts`: `${role} ${language} ${theme} ${size.width}px zoom${size.zoom}: screens, tabs, scrolling` |
| A1 | `admin-controls.spec.ts`: `admin creates an employee, first password change succeeds, and deactivation revokes access` |
| A2 | `admin-controls.spec.ts`: `admin filters evaluations by agent, classifier and score and retains the filters on reload`; `admin downloads populated CSV and PDF reports with the selected period` |
| A3 | `auth-recovery.spec.ts`: `registration validates input, retries duplicate email, and login recovers from failures before session revocation` |
| S1 | `staff-management.spec.ts`: `staff profiles paginate, filters combine, and existing identity survives account creation and team changes`; `management filters and the employee dialog contain long team lead names at 375px` |
| A4 | `admin-appeals-controls.spec.ts`: `admin fallback approval requires a rationale and routes waiting appeals to another reviewer`; `admin appeal scopes, operator/status filters and pagination match persisted records and reset details` |
| C1 | `admin-automation-settings.spec.ts`: `system settings validate the host and persist a selected model after reload` |
| C2 | `admin-automation-settings.spec.ts`: `${channel}: automation status retries and malformed CSV is rejected without enabling jobs`; `chat sampling policy validates numeric bounds and persists local thresholds without enabling sampling`; `call review policy validates seconds and optional deadline, persists and restores local settings` |
| C3 | `admin-automation-settings.spec.ts`: `chat catalog rejects reversed dates and task dialogs require inputs without mutating assignments`; `call catalog applies local direction and eligibility filters and resets them`; `suggested mapping dropdown and confirm/reject dialogs can be reviewed and dismissed`; `mapping actions and long names fit a narrow ${language} screen` |
| C4 | `zz-automation-actions.spec.ts`: `${channel}: uploads a valid schedule, enables, queues a no-source run, and disables persistently` — **pending**, chat-qa/call-qa |
| M1 | `admin-assignment-mutations.spec.ts`: `admin confirms and rejects dedicated suggested mappings and reloads persisted decisions`; `admin reassigns and cancels a dedicated chat task through real dialogs and APIs`; `admin assigns and cancels a dedicated ready call with persisted task version` |
| E1 | `analytics-export.spec.ts`: `legacy reports redirect shares URL filters with analytics and exports matching CSV/PDF data` |
| E2 | `analytics-export.spec.ts`: `export is cancellable, rejects failed later pages, and retries without a partial download` |
| J1 | `journeys.spec.ts`: `reviewer searches and scrolls a long chat, validates thumbs and required violation notes, publishes and reloads`; `reviewer loads a real synthetic recording, plays, seeks, changes speed and completes a call` |
| J2 | `journeys.spec.ts`: `agent appeal passes team lead approval and random reviewer assignment through final decision`; `team lead rejection requires a rationale and reaches the operator` |
| J3 | `journeys.spec.ts`: `role and ownership boundaries deny foreign tasks and administration endpoints` |
| G1 | `publication-gates.spec.ts`: `${channel}: AI warnings explain the publication gate, focus acknowledgement and persist the real completion` |
| W1 | `reviewer-workspace.spec.ts`: `reviewer workspaces use desktop width and keep call evidence usable on small screens`; `returning to the reviewer tab preserves unsaved text while session refresh is pending` |
| Q1 | `complaints-controls.spec.ts`: `complaints search, pagination, attribution, conflicts, source failure and conclusion persist`; `admin reassignment removes complaint access from the former reviewer` |
| Q2 | `unsaved-navigation.spec.ts`: `complaint draft survives declined browser Back and Forward, and explicit discard permits navigation` |
| Q3 | `complaint-local-evidence.spec.ts`: `complaint links a completed chat, reads evidence, copies its conclusion and completes without duplicating the score`; `complaint links an existing local call task, gates completion, then accepts its actual finished review`; `creating a new complaint review without a configured preparation source fails without a partial task` |
| H1 | `history-score-actions.spec.ts`: `${role} filters imported history, pages results and opens the scoped read-only card` — agent/reviewer/team_lead |
| H2 | `history-score-actions.spec.ts`: `agent pages personal scores and retries a comment that persists on the correct evaluation` |
| H3 | `history-score-actions.spec.ts`: `admin cancels deletion then retries a failed delete of an isolated evaluation` |
| N1 | `navigation-counts.spec.ts`: `${id}: navigation badges equal only the authenticated role's unfinished work` — admin, два reviewer, team lead, agent |
| N2 | `navigation-counts.spec.ts`: `complaint reassignment and completion update admin and both reviewers without leaking global totals`; `foreign recordings return no material and a stale authenticated tab loses protected navigation after logout` |
| N3 | `admin-controls.spec.ts`: `reviewer retries a failed notification mark and the state persists after reload` |
| T1 | `team-access.spec.ts`: `team lead switches from own team to another team, reads completed call and chat, and keeps scope after refresh`; `375px team filters contain long directory names and preserve scoped selection` |
| P1 | `preferences-assistant.spec.ts`: `preferences dropdowns change and persist language and theme, and close with Escape` |
| P2 | `preferences-assistant.spec.ts`: `assistant handles HTTP failure, synthetic streamed answer, stop, persisted history and clear` |
| R1 | `chunk-recovery.spec.ts`: `a failed page module recovers through Try again after the network is available` |
| F1 | `appeal-form-guards.spec.ts`: `appeal Cancel and Escape preserve declined drafts, and pending Send ignores duplicate submission` |
| U1 | `upload-workflow.spec.ts`: `upload rejects unsupported files, retries a failed transfer, and serializes deletion before permitting retry` |
| U2 | `upload-workflow.spec.ts`: `upload draft review survives refresh and recovers a lost rejection response without creating an evaluation` |
| D1 | `dialog-controls.spec.ts`, для `small-height` и `200-percent-reflow`: `staff add dialog retains controls and focus at ${layout.name}`; `team card scrolls to its final material and restores focus at ${layout.name}`; `evaluation detail and long-name dropdown remain operable at ${layout.name}`; `checklist tabs remain keyboard reachable and content scrolls at ${layout.name}` |

## Upload и граница AI

`/upload` доступен Admin. U1 выполняет реальную загрузку TXT и удаление через локальный backend после искусственных HTTP 503, проверяет неподдерживаемый PDF, Retry и отсутствие параллельной оценки во время удаления. U2 сначала подготавливает AI-черновик прямо в изолированной базе, затем использует реальные recovery/reject API: сохраняет rationale, требует подтверждения человеком, моделирует потерю ответа после уже выполненного решения, проверяет восстановление статуса без повторной записи оценки.

Это **не** полный путь «загрузка аудио → транскрипция → AI → публикация»: аудиотранскрипция, refinement, фактическое распределение speaker roles и генерация AI в U1/U2 не выполняются. В G1 AI-результат тоже подготовлен заранее; проверяются предупреждения, человеческое решение и сохранение происхождения итоговой оценки.

## Обход интерфейса и визуальные условия

- L2: все 72 комбинации прошли на финальной сборке: 4 роли × 3 языка × 2 темы × 3 размера/режима.
- Размеры L2: 1440×900, 375×640 и CSS viewport 640×300, соответствующий reflow окна 1280×600 при 200%. Последнее не проверяет реальное изменение browser zoom и растеризацию шрифтов.
- L2 открывает страницы напрямую, нажимает tabs, проверяет края прокручиваемых областей, wheel, Ctrl+Home/End, reload и ошибки JavaScript. Приложение к результату — `screen-and-scroll-evidence`; строки `inventory-only` нельзя считать выполненными действиями.
- L1 содержит дополнительные обходы ширин 375/768/1366/1440; эти inventory-сценарии не входят в основной архив из 79. В нём прошли login/logout, навигация/предпочтения и Axe для каждой роли. Axe проверяет **входной экран каждой роли**, а не все состояния и диалоги приложения.
- D1 проверяет небольшую высоту, нижние контролы, отсутствие перекрывающего overlay, Escape, возврат фокуса и снятие scroll lock. D1 осматривает Delete; отдельный H3 действительно удаляет изолированную оценку. S1/T1 и C3 отдельно проверяют длинные имена на 375px, включая RU/AZ mappings.
- Используется Brave через Playwright с синтетическими данными. Safari/Firefox, реальные мобильные устройства, touch-жесты и ручное чтение screen reader не входят в доказательство.

## Обнаруженные действия и условия без полного action-E2E

| Область | Что ещё не подтверждено этим набором | Что есть вместо полного сценария |
| --- | --- | --- |
| Внешние Calls / Jira | Часовой Jira sync, ручной admin sync, успешный поиск контактов по основному/альтернативному номеру, реальные media и сообщения из upstream | В fixture внешние службы отключены; Q1 проверяет честный отказ источников. Наличие кандидатов/логика поиска имеют отдельные модульные проверки, но не живой upstream E2E |
| Жалобы | Успешное создание новой дополнительной оценки с подготовкой из upstream; успешный `contact_not_found` после настоящего поиска; реальная навигация авторизованного Jira | Q3 уже подтверждает local linking, readonly evidence/scoped OGG, clipboard, mock Jira popup, `evaluated` и отсутствие partial task при отказе подготовки. Q1 — `cannot_evaluate`, Q2 — черновик. Jira не изменяется |
| Автоматическое распределение | Реальное внешнее расписание, успешный source-driven assignment, длительный цикл/перезапуск worker. Локальные Enable/Run/Disable пройдены | C2/C4 пройдены с synthetic CSV и отключёнными sources; M1 подтверждает ручные операции |
| Оценки и история | Периоды/ошибки reviewer dashboard, все комбинации фильтров и пустых/ошибочных ответов | H1–H3 уже подтверждают даты/пагинацию/карточку истории, Delete и комментарий. `/me` не имеет переключателя периода; summary и страницы проверены |
| Апелляции Admin | Fallback Reject, переназначение уже начатой reviewer-оценки, конфликт версий между двумя браузерными сессиями | A4 подтверждает fallback Approve и назначение pending_assignment, фильтры/страницы/reload; J2 — обычная цепочка Agent → Lead → Reviewer |
| Роли сотрудников | Все переходы ролей; каждое сочетание reviewer availability/groups; одновременные изменения двух администраторов через браузер | Unit/API регрессии сохраняют последнего admin, отклоняют отозванного actor после hashing, синхронизируют имя профиля; S1/A1 проверяют основные UI-пути |
| Черновики | Back/Forward для каждой отдельной формы и принудительное закрытие процесса браузера | Q2 — браузерный сценарий для жалобы; общая защита и формы Settings/Staff/NewAppeal/Lead/ReviewScorecard проверяются unit-тестами. Это не доказательство сохранения при аварийном завершении |
| Auth | Автоматический немедленный выход на любой произвольный mutation-401; production self-registration | N2/A3 проверяют отказ backend, focus или reload сессии. Регистрация включена в development fixture; production отключает её без явной настройки |
| Upload / AI / ASR / CARE | Реальная генерация и её качество, большие файлы, реальный ASR/refinement, полноценная публикация загруженного AI-черновика | U1/U2 и G1 проверяют ограниченные границы; P2 подменяет SSE. Внешние/локальные AI-сервисы не подключены к этому прогону |
| Доступность | Все комбинации языка/роли с клавиатурой, screen reader, zoom ОС, touch; исчерпывающая проверка семантики каждого элемента | Axe входных страниц, tabs/Enter, фокус/Escape, прокрутка и матрица размеров |

## Связанные регрессионные проверки без браузера

Дополняют E2E, но не увеличивают число выполненных пользовательских сценариев:

- `src/hooks/useUnsavedChanges*.test.tsx`: Back/Forward, программный переход, одиночный prompt, освобождение после Save.
- `src/pages/Settings.unsaved.test.tsx`: переход между вкладками, ошибка Save, новые правки во время предыдущего запроса.
- `src/components/StaffDialog.test.tsx`, `src/pages/me/NewAppealDialog.test.tsx`: discard, duplicate-submit, pending/success и beforeunload.
- `src/pages/appeals/Notifications.test.tsx`: безопасные ошибки загрузки/Mark read и Retry.
- `src/pages/Evaluations.test.tsx`: повторное удаление не отправляется, завершение старого запроса не закрывает другую карточку.
- `server/src/users/staffAccounts.test.ts`: последний активный admin, отзыв actor во время hashing, удалённая цель, атомарное переименование связанного профиля.
- `server/src/__tests__/routes/me-summary-month.test.ts`: календарный месяц Баку, граница 00:00, приоритет даты контакта перед датой оценки/импорта; два сценария воспроизвели дефект до исправления и прошли после него. Совместно с effective-aggregate suites: 5/5 API-тестов.

Итоговые unit/backend/build результаты приведены ниже. Этот документ не выдаёт наличие исходников теста, сборку или HTTP mock за проверку реального внешнего сервиса.

## Технические проверки и выпуск

- Сервер: **2247 тестов / 267 файлов — passed**, отдельный DATA_DIR в `/tmp`, итог `/tmp/quality-ui-server-isolated-final.log`. Заблокированный sandbox-запуск остановлен; успешный запуск имел доступ только к тестовым HTTP-сокетам.
- Клиент: **631 тест / 114 файлов — passed**, `/tmp/quality-ui-frontend-release.log`.
- Dev launcher/watch: **4/4 passed**; генератор реестра: **4/4 passed**.
- TypeScript клиента и сервера, ESLint (0 ошибок; 77 существующих предупреждений), Vite build и Docker build прошли. Формат изменённых файлов проверен. Общий `format:check` дополнительно отмечает 11 не изменённых этой задачей серверных тестовых/AI файлов; они совпадают с исходной копией до задачи и не исправлялись массово.
- Исходная frontend-сборка до задачи совпала со всеми 118 файлами `dist` текущего GitHub. В чистом checkout выпуска меняются 16 серверных JS-модулей и frontend; посторонние изменения основной рабочей копии не публикуются.
- Production Docker: health, вход 4 ролей, счётчики и основные ролевые API, начальные JS/CSS — passed на свежей синтетической базе. Тот же образ открыт вручную в Brave с loopback-origin; вход, «Управление» и общие фильтры аналитики/экспорта проверены.
- Локальный backup/restore существующим скриптом прошёл на остановленной синтетической базе. Рабочий сервер не обновлялся и его backup не делался; [порядок обновления и отката](quality-ui-release.md) подготовлен отдельно.
- Итоговый production diff просмотрен непосредственно основным агентом. После исправлений подтверждённых блокирующих дефектов в проверенном объёме не осталось; перечисленные выше пробелы не превращаются в успешные проверки.

Скриншоты синтетических данных: [Управление в Docker/Brave](qa-screenshots/management-docker-brave.png), [экспорт с общими фильтрами](qa-screenshots/analytics-export-docker-brave.png), [жалоба до исправления](qa-screenshots/complaint-before.png), [после исправления](qa-screenshots/complaint-after.png), [длинные имена команды](qa-screenshots/team-long-names-after.png), [длинное имя тимлидера в управлении](qa-screenshots/staff-long-name-after.png).

HTML-реестр проверен генератором и unit-тестами; его открытие через browser-tool заблокировано политикой `file://`. Это не браузерная проверка кнопок самого HTML-отчёта. Файл можно открыть локально вручную; матрица приложения выполнялась через HTTP в Brave.
