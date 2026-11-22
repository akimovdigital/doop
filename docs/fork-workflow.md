# Схема форка Doop Dev

Снимок снят 22 ноября 2026, 11:55 UTC командами `git fetch origin`, `git fetch upstream`, `git ls-remote`, `git rev-list` и `gh api`. Цифры ниже — из этого прогона. Код приложения не менялся.

Репозиторий: `akimovdigital/doop`, форк `kgoedecke/doop`, лицензия AGPL-3.0 (`gh repo view`, файл `LICENSE`). Ветка по умолчанию — `main`.

## Сделано 22 ноября 2026

Снимок выше снят в 11:55 UTC. Дальше, с согласия Никиты, сделано обычными push, без force. То согласие — на эти push. Следующие слияния внутри форка отдельного «да» не требуют: агент ревьюит diff и сливает squash-ом. «Да» Никиты нужно только на PR, комментарии и CLA у автора и на публикацию сборок. Правила целиком — в разделе «Как работаем с Git».

`main` форка перемотан с `b2b4536e` на `8a53f23d2fb71394279c4d1476eb830befb50995`. Перед push `git rev-list --count upstream/main..origin/main` был 0, `upstream/main` был тем же `8a53f23d`. Сейчас `origin/main` совпадает с `upstream/main`: позади 0, впереди 0.

Окно Doop Cloud убрано revert-коммитом `0ad297ca4b5b84724bfce49921762de2e58d464f` («Revert "feat(desktop): open Doop Cloud alongside Local Dev"», revert `059d3a55`). `local/doop-dev` fast-forward с `059d3a55` на `0ad297ca`. Тот же коммит на ветке `cursor/revert-doop-cloud-c391`. Удалены `desktop/src-tauri/src/dev_modes.rs` и абзац про окно в `DESIGN.md`. Сразу после этого revert от `upstream/main` сборка была позади на 0 и впереди на 35. Перед правилами Git вершина `local/doop-dev` — `4989a4bda79b6bf4efe2d74e35274d7f2839f03e` (merge PR #1): позади 0, впереди 38.

Повторно эти два шага не запускать.

## Роли

| Ветка            | Где                        | Зачем                                                                                                                       |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `main` автора    | `kgoedecke/doop`           | Источник. Сейчас `8a53f23d` (2026-11-22 03:15:47 +0100), «feat(canvas): drawing a frame around shapes takes them in (#586)» |
| `main` форка     | `akimovdigital/doop`       | Зеркало `main` автора. Своих коммитов на нём нет                                                                            |
| `local/doop-dev` | форк                       | Наша сборка Doop Dev                                                                                                        |
| ветка PR автору  | от свежего `upstream/main` | Одна доработка без бренда Doop Dev, без своего канала обновлений и без `http://127.0.0.1:4437`                              |
| ветка форка      | от `local/doop-dev`        | Доработка, которая живёт только у нас                                                                                       |

Направление одно: `upstream/main` → `main` форка → `local/doop-dev`. Обратно, из `local/doop-dev` в `main` форка, не вливаем: иначе зеркало перестанет быть зеркалом.

Как часто: перед каждой новой задачей и не реже раза в неделю, как в разделе «Как работаем с Git». С 19 по 22 ноября `main` автора ушёл на 45 коммитов, а `main` форка остался на месте. `local/doop-dev` за это время синхронизировали отдельно.

## Как работаем с Git

1. Каждая задача начинается с новой ветки.
   - Ветка от свежего `origin/local/doop-dev`. Имя: `feat/`, `fix/`, `perf/` или `chore/`.
   - Если задача — кандидат в PR автору, ветка от свежего `upstream/main`. Имя: `upstream/…`. Без брендинга Doop Dev, без своего канала обновлений и без `127.0.0.1:4437`.
   - Перед стартом подтянуть `upstream` и `origin`.
2. Коммит после каждого законченного логического шага, который собирается. Коммиты маленькие, conventional commits. Секреты и ключи в коммиты не попадают.
3. Push своей ветки после каждого коммита или минимум в конце каждого запуска. В `main`, `local/doop-dev` и чужие ветки напрямую не пушить. Force push запрещён, кроме своей рабочей ветки до открытия PR.
4. PR в `local/doop-dev`, когда задача готова, а typecheck, lint и vitest проходят. Если vitest уже красный, нельзя добавлять новые падения. Затронутый сценарий проверен, для UI нужен скриншот.
   - Агент сам ревьюит diff и сливает squash-ом. Слияния внутри форка Никита разрешил без отдельного «да».
   - После слияния удалить ветку и пересобрать Doop Dev.app на Маке из свежего `local/doop-dev`, локально и без публикации.
5. Синхронизация с автором перед каждой новой задачей и не реже раза в неделю.
   - `main` форка перематывается до `upstream/main`, только fast-forward.
   - Затем PR `sync/upstream-<sha>` из `main` в `local/doop-dev`. Конфликты решать с сохранением наших изменений и изменений автора, прогнать проверки и слить.
6. PR автору (`kgoedecke/doop`): ветка `upstream/…` готовится и проверяется в форке. Открыть PR, писать комментарии и подписывать CLA у автора только после «да» Никиты. Это и публикация сборок — единственное, что требует его «да».
7. Отчёт после каждого запуска, по-русски и коротко: что сделано, ветка и PR, SHA, проверки, что осталось.

## Где что стояло на снимке 11:55 UTC

До fast-forward `main` форка был `b2b4536e` (2026-11-19 01:13:07 −0800), «perf(canvas): stop restyling the whole page on every pan step (#439)». Сейчас он равен `8a53f23d`, см. раздел выше.

На снимке от `upstream/main`: позади 45, впереди 0. `git merge-base` совпадал с `b2b4536e`, `b2b4536e` был предком `8a53f23d`. Поэтому хватило fast-forward, rebase не понадобился. Сейчас отставания нет.

От `local/doop-dev`: позади 79, впереди 0. Своих коммитов нет: 79 = 45 коммитов автора + 34 коммита сборки.

`local/doop-dev` на снимке был `059d3a55` (2026-11-22 14:18:57 +0300), «feat(desktop): open Doop Cloud alongside Local Dev». Диапазон после прошлого разбора: `ba9753fb` (2026-11-22 14:01:14 +0300) .. `059d3a55`, один коммит. Revert `0ad297ca` после этого был вершиной. Перед правилами Git вершина — `4989a4bda79b6bf4efe2d74e35274d7f2839f03e`.

На снимке от `upstream/main`: позади 0, впереди 34. `8a53f23d` уже был предок. После revert впереди 35, позади 0.

34 коммита на снимке — с `48d8c5aa` (2026-11-20 21:54:29 +0300, «chore: configure local Doop Dev builds») по `059d3a55`. Внутри два синка с автором: `0146a505` (2026-11-21 19:48:53 +0300) и `3ec33043` (2026-11-22 13:53:13 +0300, родители `7f2ca766` и `8a53f23d`). Дифф к `upstream/main` на снимке: 76 файлов, +6277 / −687. Уникальное: локальная оболочка Doop Dev, вкладки и группы, секции, панель Framework, ускорение холста, ручной вход. Окно Doop Cloud из `059d3a55` после этого снято revert `0ad297ca`.

Прошлый дифф на `ba9753fb` был 75 файлов, +6043 / −678. Коммит `059d3a55` добавляет к нему 3 файла, +329 / −104.

## Бренд, чтобы синк не ломался

Бренд живёт только на `local/doop-dev`. На `main` форка его нет, в PR автору его не берём.

Базовый `desktop/src-tauri/tauri.conf.json` остаётся авторским и на сборке тоже: productName `doop`, identifier `design.doop.desktop`, version `0.14.0`, канал `https://doop.design/desktop/latest.json`. Сборка Dev подменяет часть полей файлом `doop-dev.tauri.json` (`build-doop-dev.sh`: `bun run build --bundles app --config ../doop-dev.tauri.json`).

Оверлей задаёт productName `Doop Dev`, identifier `digital.akimov.doop-test`, `frontendDist` `http://127.0.0.1:4437`, пустые `plugins.updater.endpoints` и deep-link schemes, иконку `icons/doop-test-dev.icns`. Ключа `version` в оверлее нет, номер берётся из базового файла.

Отдельные файлы, которых нет у автора:

- `doop-dev.tauri.json`
- `build-doop-dev.sh`
- `DESIGN.md` — заметки сборки; общий гайд автора остаётся `.context/DESIGN.md`
- `desktop/doop-test-dev-icon.png`
- `desktop/src-tauri/icons/doop-test-dev.icns`
- `desktop/src-tauri/src/local_test_login.rs` — вход на `http://127.0.0.1:4437`

Правки общих файлов, которые держат локальный URL и тестовый identifier. В PR автору их вырезаем, при синке сборки сохраняем нашу сторону:

- `desktop/src-tauri/capabilities/default.json` — remote URL заменён на `http://127.0.0.1:4437`
- `desktop/src-tauri/src/updates.rs` — обновление разрешено только identifier `design.doop.desktop` и адресу `https://doop.design` / `https://www.doop.design`

`desktop/src-tauri/src/dev_modes.rs` и вызовы из `main.rs` сняты revert `0ad297ca`. В PR автору этот файл не возвращать.

`updates.rs` при этом полезен и автору: официальный фид не должен ставиться на чужой identifier. В такой PR брать логику, а тест с `digital.akimov.doop-test` и локальный URL оставлять в форке.

## Версия

Политика: номер оболочки Dev равен авторскому. На этом снимке и `upstream/main`, и `local/doop-dev` имеют `0.14.0` в `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` и `desktop/src-tauri-chromium/Cargo.toml`. `package.json` на обоих — `0.15.0`: это номер приложения, он тоже совпадает с автором.

Серию `0.0.x` в `doop-dev.tauri.json` не возвращаем. Сборки отличаем identifier, пустым каналом обновлений и SHA. Когда понадобится метка именно нашей сборки, ставим свой тег на `local/doop-dev`, например `doop-dev/0ad297ca`. Имена `v0.14.0` и `desktop-v0.14.0` принадлежат автору.

Когда автор поднимет номер оболочки, Dev повторяет этот номер в базовых файлах. Отдельный меньший номер в оверлее не заводим.

## Окно Doop Cloud

Коммит `059d3a55` добавляет в сборку с identifier `digital.akimov.doop-test` пункт Window: Local Dev и Doop Cloud. Doop Cloud открывает `https://doop.design/auth` во втором окне, со своим хранилищем сайта и обычным заголовком macOS (`desktop/src-tauri/src/dev_modes.rs`, абзац в `DESIGN.md`).

Для схемы это лишнее. Официальное приложение автора уже клиент облака: identifier `design.doop.desktop`, productName `doop`, канал `https://doop.design/desktop/latest.json`, сервер по умолчанию `https://doop.design` (`desktop/src-tauri/src/server.rs`, меню «Use doop.design…», когда выбран другой сервер). Второе окно в тестовой оболочке повторяло этот клиент без официального канала и без identifier автора. В PR автору оно не идёт. Doop Dev остаётся локальной сборкой на `127.0.0.1:4437`, облако остаётся официальным приложением.

Окно убрано. Revert `0ad297ca4b5b84724bfce49921762de2e58d464f` откатил `059d3a55` и уже стоит на `local/doop-dev`. Повторный revert не нужен.

## Инвентарь `akimovdigital/doop`

На снимке 11:55 UTC `gh api repos/akimovdigital/doop/branches` и `git ls-remote --heads origin` показали две ветки. Сразу после fast-forward и revert вершины были `main` = `8a53f23d`, `local/doop-dev` = `0ad297ca`. Перед правилами Git `main` всё ещё `8a53f23d2fb71394279c4d1476eb830befb50995`, а `local/doop-dev` — `4989a4bda79b6bf4efe2d74e35274d7f2839f03e`. Таблица ниже — снимок 11:55, не текущие SHA.

| Ветка            | SHA        | Дата коммита              | От `upstream/main`   | От `local/doop-dev`  | Уникальное                          |
| ---------------- | ---------- | ------------------------- | -------------------- | -------------------- | ----------------------------------- |
| `main`           | `b2b4536e` | 2026-11-19 01:13:07 −0800 | позади 45, впереди 0 | позади 79, впереди 0 | ничего, старый `main` автора        |
| `local/doop-dev` | `059d3a55` | 2026-11-22 14:18:57 +0300 | позади 0, впереди 34 | —                    | 34 коммита сборки поверх `8a53f23d` |

`git ls-remote --tags origin` пуст. `gh api repos/akimovdigital/doop/tags` пуст. `gh release list` пуст. `actions/artifacts` и `actions/runs` — `total_count` 0.

PR: `gh pr list --repo akimovdigital/doop --state all` пуст; поиск `repo:akimovdigital/doop is:pr` — 0. Поиск `repo:kgoedecke/doop author:akimovdigital is:pr` — 0. Поиск `repo:kgoedecke/doop head:akimovdigital is:pr` — 0. Открытых и закрытых PR форка и наших PR автору на снимке нет. Позже PR #1 с `chore/fork-workflow` влит в `local/doop-dev` как `4989a4bda79b6bf4efe2d74e35274d7f2839f03e`.

У автора `git ls-remote --tags` даёт 41 строку и 35 имён тегов (`v0.1.0`…`v0.15.0`, `desktop-v0.1.0`…`desktop-v0.14.0`, `desktop-updates`, `canva-review-demo`). Они остаются у автора. В форк их не копируем и у автора не удаляем.

Ветка `chore/fork-workflow` в снимок не входит: на ней только этот документ.

## Оставить, удалить, слить

| Объект                      | Решение                                          | Почему                                                                       |
| --------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `main` форка                | Слито fast-forward до `8a53f23d`                 | Было позади на 45, впереди на 0. Push сделан, сейчас зеркало                 |
| `local/doop-dev`            | Оставить. Перед правилами Git вершина `4989a4bd` | Наша сборка. Revert `0ad297ca` принят поверх `059d3a55` и остаётся в истории |
| `chore/fork-workflow`       | Влито PR #1, ветка удалена                       | Только этот документ. После мержа ветка не нужна                             |
| теги форка                  | Удалять нечего                                   | Тегов нет                                                                    |
| теги автора (35 имён)       | Оставить у автора                                | Чужие релизы. В форк не зеркалировать                                        |
| релизы и артефакты форка    | Удалять нечего                                   | Списков нет                                                                  |
| PR                          | Удалять и закрывать нечего                       | На снимке 11:55 PR не было. Позже влит PR #1                                 |
| окно Doop Cloud, `059d3a55` | Убрано revert `0ad297ca`                         | Код окна снят с `local/doop-dev`. История коммита `059d3a55` остаётся        |

На снимке лишних веток, копий и сборок не было. Отставание `main` закрыто fast-forward до `8a53f23d`.

## Команды синка

Ниже команды для следующего синка. Fast-forward `main` до `8a53f23d` и revert окна уже выполнены, повторять их не нужно. Force не использовался. В `kgoedecke/doop` ничего не отправлялось.

Один раз:

```bash
git remote add upstream https://github.com/kgoedecke/doop.git
```

Каждый синк. Сначала зеркало, потом PR в сборку. Если первая проверка не равна 0, `main` форка уже не зеркало: остановиться и разобрать коммиты, fast-forward не делать. В `local/doop-dev` напрямую не пушить и не мержить.

```bash
git fetch upstream
git fetch origin

git rev-list --count upstream/main..origin/main
git rev-list --count origin/main..upstream/main

git push origin upstream/main:refs/heads/main

git checkout -b sync/upstream-<sha> origin/main
```

`<sha>` — короткий SHA `upstream/main`, на который встал `main` форка. PR из этой ветки в `local/doop-dev`. Конфликты решать с сохранением наших изменений и изменений автора. Typecheck, lint и vitest, затем squash и удаление ветки.

На снимке 22.11.2026 первая проверка дала 0, вторая — 45. Fast-forward уже поставил `main` на `8a53f23d`. `8a53f23d` предок и `059d3a55`, и `0ad297ca`, и `4989a4bd`. Пока автор не уйдёт дальше `8a53f23d`, PR синка новых коммитов автора не принесёт.

Ветка для PR автору. Готовить и проверять её в форке. Открывать PR в `kgoedecke/doop`, писать комментарии и подписывать CLA только после «да» Никиты.

```bash
git fetch upstream
git fetch origin
git checkout -b upstream/<тема> upstream/main
```

Не переносить `doop-dev.tauri.json`, `build-doop-dev.sh`, `DESIGN.md`, `dev_modes.rs`, `local_test_login.rs`, иконки `doop-test-dev` и замену remote URL на `127.0.0.1:4437`. Брендинг Doop Dev и свой канал обновлений тоже не переносить.

Ветка форка. Имя: `feat/`, `fix/`, `perf/` или `chore/`.

```bash
git fetch upstream
git fetch origin
git checkout -b <префикс>/<тема> origin/local/doop-dev
```

Свой тег сборки, когда он понадобится. Сейчас не ставить: тегов в форке нет, и этот запуск их не создаёт.

```bash
git checkout local/doop-dev
git tag doop-dev/0ad297ca 0ad297ca4b5b84724bfce49921762de2e58d464f
git push origin doop-dev/0ad297ca
```

## Команды удаления

Сейчас не запускать. Удалять нечего: обе ветки нужны, тегов нет.

Шаблон на будущий дубль. `main` и `local/doop-dev` в него не подставлять.

```bash
git push origin --delete <имя-ветки>
git push origin :refs/tags/<имя-тега>
```

Окно Doop Cloud уже убрано коммитом `0ad297ca`. Команда, которой это сделано, повторно не запускается:

```bash
git checkout local/doop-dev
git revert --no-edit 059d3a55b663d64c3a375f8a417073253b0ff1db
```

Ветка `chore/fork-workflow` после мержа PR #1 уже удалена. Команду ниже повторно не запускать:

```bash
git push origin --delete chore/fork-workflow
```

Удаление было после мержа в `local/doop-dev`, не раньше.

## Тонкий слой

Бренд и настройки Doop Dev живут в своих файлах. Общий файл автора меняется только коротким стыком, без которого доработка не работает. Уже записанный раздел «Бренд, чтобы синк не ломался» остаётся: базовый `tauri.conf.json` авторский, оверлей — `doop-dev.tauri.json`.

Свои файлы бренда и локальной оболочки:

- `doop-dev.tauri.json` — productName `Doop Dev`, identifier `digital.akimov.doop-test`, фронт `http://127.0.0.1:4437`, пустые `plugins.updater.endpoints`, иконка
- `build-doop-dev.sh` — сборка с этим оверлеем
- `DESIGN.md` — заметки сборки, отдельно от `.context/DESIGN.md`
- `desktop/doop-test-dev-icon.png`, `desktop/src-tauri/icons/doop-test-dev.icns`
- `desktop/src-tauri/src/local_test_login.rs` — вход на `http://127.0.0.1:4437`

Рядом лежат новые модули, которых у автора нет. Это не общие файлы: `server/pageSections.ts`, `shared/sections.ts`, `src/components/CanvasSections.tsx`, `src/components/SectionInspector.tsx`, `src/components/FrameworkPanel.tsx`, `src/components/frameAdmission.ts`, `src/lib/canvasSections.ts`, `src/lib/frameworkFiles.ts`, `desktop/src-tauri/permissions/autogenerated/open_canvas_window.toml`, `tests/sections.test.ts`, `tests/frameworkFiles.test.ts`, `tests/desktopTabsBrowser.test.ts`. Правила и схема — `.cursor/rules/git-workflow.mdc`, `docs/fork-workflow.md`, `AGENTS.md`.

Снимок общих правок снят 22 ноября 2026 командой `git diff --name-status 8a53f23d2fb71394279c4d1476eb830befb50995 origin/local/doop-dev`. Вершина `origin/local/doop-dev` — `433808c`. Дифф: 78 файлов, +6300 / −678. Ниже только изменённые файлы автора (`M`), с причиной из этого диффа. После следующего синка список переснять той же командой.

Оболочка и локальные настройки, которые всё ещё сидят в общих файлах. При синке сборки сохранять нашу сторону. В PR автору локальный URL, identifier `digital.akimov.doop-test` и пустой канал не переносить.

- `desktop/src-tauri/capabilities/default.json` — remote URL заменён на `http://127.0.0.1:4437`, окна `main` и `canvas-*`, разрешение `allow-open-canvas-window`
- `desktop/src-tauri/src/updates.rs` — обновление только для identifier `design.doop.desktop` и адреса `https://doop.design` / `https://www.doop.design`; пункт Check for Updates скрыт у другого identifier; тест запрещает `digital.akimov.doop-test` и `http://127.0.0.1:4437`
- `desktop/src-tauri/src/main.rs` — общий сборщик окна для main и дополнительных окон холста; маркер `__DOOP_DESKTOP_TRAFFIC_LIGHTS__`; для `digital.akimov.doop-test` окно macOS открывается на весь экран без анимации; вызов `local_test_login`; команда `open_canvas_window`. Тест адреса использует `http://127.0.0.1:4437`
- `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri-chromium/Cargo.toml` — фича `NSScreen` у `objc2-app-kit`, чтобы выставить окно в `visibleFrame` до показа
- `desktop/src-tauri/build.rs` — команда `open_canvas_window` в списке разрешений сборки
- `src/lib/shell.ts` — читает `__DOOP_DESKTOP_TRAFFIC_LIGHTS__`; оболочкой считается только верхнее окно
- `tests/shell.test.ts` — маркер кнопок окна, в том числе для сборки `0.0.2`

Вкладки, группы и несколько окон.

- `src/components/DesktopTabs.tsx` — Home, закрепление, группы с именем и фильтром, компактная полоса, меню вкладки (переименовать, pin, группа, split, новое окно), Enter/Space
- `src/lib/desktop.ts` — состояние вкладок, группы в `doop-tab-groups:<user>`, split, отдельное окно, страница вкладки. Перетаскивание остаётся внутри своего ряда, шорткат открывает запомненную страницу. Переход на Home по ⌘1 стоит в авторском `tabShortcutTarget`
- `src/App.tsx` — split двух вкладок, `tabpanel`, локальный агент только в верхнем окне, отступ полосы 38px
- `src/lib/appMenu.ts` — меню страницы пересобирается при фокусе окна
- `desktop/src-tauri/src/app_menu.rs`, `desktop/src-tauri/src/view_menu.rs` — на macOS пункт уходит в сфокусированное окно. На других ОС этот дифф релей выключает
- `src/lib/pageUrl.ts` — запоминает страницу открытой вкладки
- `src/pages/Home.tsx` — свежий список холстов снимает вкладки удалённых и отбрасывает устаревший ответ
- `src/components/ui/icons.tsx` — иконки Home, pin и секции
- `tests/desktopTabShortcuts.test.ts`, `tests/desktopTabsDrag.test.tsx` — pin, страница вкладки, перетаскивание внутри группы

Секции.

- `shared/types.ts` — `CanvasSection`, переносы фреймов, `landingSectionId`
- `server/actions.ts`, `server/db/persist.ts`, `server/store.ts` — запись раскладки страницы и секций
- `server/index.ts` — HTTP секций и приём `frameMoves`; тот же файл отдаёт `?snapshot` для полного кадра
- `src/lib/store.ts` — выбранная секция, вкладка панели `framework`, применение `frameMoves`; скрытый интерфейс сбрасывается при смене холста
- `src/lib/tools.ts` — инструмент Section, ⇧S
- `src/lib/pageLink.ts` — параметр `section` в адресе
- `src/components/FrameContextMenu.tsx` — обернуть выделение в секцию
- `src/components/LayersPanel.tsx` — секции на странице; вкладки панели — Layers и Framework. У автора на `8a53f23d` здесь Layers, Components и Tokens
- `src/components/ui/panel.tsx` — ref у тела панели, чтобы прокручивать дерево слоёв
- `src/pages/CanvasPage.tsx`, `src/components/SideRail.tsx` — инспектор секции
- `src/lib/i18n/en/canvas.ts`, `src/lib/i18n/pt-BR/canvas.ts` — строки секций
- `tests/pageControlsBrowser.test.ts` — рисование секции, обзор на zoom 0.01, камера при смене холста
- `tests/layersRange.test.tsx` — прокрутка дерева к строке диапазона

Framework.

- `package.json`, `bun.lock` — зависимость `yaml` `2.9.0` для импорта токенов
- `src/lib/frameExport.ts` — `saveBlob` экспортирован: панель Framework скачивает CSS, JSON и ZIP
- `src/lib/i18n/en/panels.ts`, `src/lib/i18n/pt-BR/panels.ts` — строки Framework; подпись вкладок «Layers and Framework»

Холст.

- `src/components/Stage.tsx` — секции на сцене, допуск далёких фреймов, камеры страниц, нижний zoom 0.01
- `src/components/frameAdmission.ts` — новый файл, в этом списке его нет. Стыки: `src/components/FrameView.tsx` (документ по допуску, короткий заголовок секции на обзоре), `src/lib/frameBridge.ts` (документ монтируется, когда камера близко или команда просит содержимое)
- `src/lib/frameRuntime.ts` — наблюдатель обводки только у отдельной фигуры, не у всего HTML-дерева
- `src/lib/ws.ts` — первый снимок комнаты может прийти gzip; join сообщает `pageLayoutMoves`
- `src/lib/follow.ts` — нижний zoom следования 0.01, как у обзора большого холста
- `src/components/PrototypePlayer.tsx` — заготовка Present скрыта, пока экран не готов
- `server/previews.ts`, `server/screenshot.ts`, `server/thumbs.ts` — отдельный полный снимок кадра (`canvas`), не карточка превью
- `tests/pageCanvasBrowser.test.ts`, `tests/fixtures/pages.html` — далёкие документы не монтируются, пока их не запросили
- `tests/thumbs.test.ts` — полный снимок хранится отдельно от карточки
- `tests/vectorPaintBrowser.test.ts` — обводка фигуры не наблюдает анимированное HTML-поддерево
- `tests/follow.test.ts` — следование за агентом переживает смену его страницы и снимается ручной камерой
- `tests/hideUi.test.ts` — скрытый интерфейс снова виден при переходе на другой холст

## Чек-лист синка новой версии

Порядок синка не меняется и описан в «Как работаем с Git» и в «Команды синка»: `main` форка fast-forward до `upstream/main`, затем PR `sync/upstream-<sha>` в `local/doop-dev`. В `local/doop-dev` напрямую не пушить. Force не использовать. Этот чек-лист — что прочитать и проверить, когда автор выпускает новую версию, например оболочку 0.15 или приложение 0.16. На снимке оболочка `0.14.0`, приложение в `package.json` и `CHANGELOG.md` — `0.15.0`.

- [ ] Прочитать `CHANGELOG.md` и `desktop/CHANGELOG.md` между старым и новым `upstream/main`.
- [ ] Прочитать список слитых PR за тот же диапазон. Для диапазона коммитов смотреть merge-коммиты и номера PR в сообщениях: `git log --oneline <старый>..<новый>`.
- [ ] Снять `git diff --name-only <старый> <новый>` и отметить пересечение с общими файлами из раздела «Тонкий слой». Конфликт или пересечение разобрать до мержа: сохранить наши изменения и изменения автора.
- [ ] Прогнать `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`. Если vitest уже красный на вершине до синка, новых падений не добавлять.
- [ ] Коротко проверить наши доработки на сборке этой версии.
  - Вкладки и группы: Home, закрепление, группа с именем и фильтром, закреплённые видны во всех группах, меню вкладки (переименовать, pin, группа, split, новое окно), Enter/Space, split двух холстов, отдельное окно, удалённый холст пропадает из полосы.
  - Секции: инструмент Section (⇧S), рисование и обёртка выделения, заливка, обводка, радиус, инспектор, заголовок читается на обзоре, секция сохраняется и открывается по ссылке с `section`.
  - Framework: левая панель — Layers и Framework. Overview показывает палитру, типографику, spacing и radii. Импорт CSS, JSON, HTML, YAML, Markdown и выбранного фрейма. Экспорт CSS, JSON, DESIGN.md и ZIP.
  - Холст: обзор большого холста до zoom 0.01, камера страницы возвращается при смене холста, далёкий фрейм не монтирует iframe, Present не показывает заготовку до готовности экрана.
  - Локальный вход: ручной вход на `http://127.0.0.1:4437`.
  - Оболочка Doop Dev: имя Doop Dev, identifier `digital.akimov.doop-test`, иконка `doop-test-dev`, фронт `127.0.0.1:4437`, канал обновлений пустой, на macOS окно на весь экран без анимации, кнопки окна не наезжают на вкладки, пункта Check for Updates нет, окна Doop Cloud нет.
- [ ] Сверить меню и функции с официальным Doop той же версии. На базе `8a53f23d` у автора в меню приложения есть Check for Updates, в левой панели Layers, Components и Tokens, одного окна холста достаточно. У нас Check for Updates скрыт, панель — Layers и Framework, окон холста может быть несколько, меню вкладки содержит pin, группу, split и новое окно. Если автор в новой версии добавил тот же пункт, записать, чья сторона осталась.
- [ ] В отчёте перечислить, что изменилось у автора (по CHANGELOG и слитым PR) и по каждому пункту — задела ли правка наши файлы.

Дальше обычный PR `sync/upstream-<sha>`: проверки, squash, удаление ветки.

## PR автору принимается

Чек-лист для внешнего PR в [kgoedecke/doop](https://github.com/kgoedecke/doop). Снят 22 ноября 2026 с `main` автора (`CONTRIBUTING.md`, `CLA.md`, `.github/workflows/ci.yml`, `.github/workflows/cla.yml`, `commitlint.config.js`) и с обсуждений на GitHub. Файла шаблона PR у автора нет: в `.github/` только `actions/`, `assets/`, `workflows/`. Описание ниже — то, что стоит в принятых PR и что требует CI.

Готовый кандидат ждёт «да» Никиты. До этого PR в `kgoedecke/doop` не открывать: ни описание, ни комментарий, ни подпись CLA.

### Перед веткой

- [ ] Правка одна и небольшая. Один смысл, мало файлов. Автор закрывает пачки: [#505](https://github.com/kgoedecke/doop/pull/505) (четыре правки безопасности) закрыт, из него взят один фикс в его [#570](https://github.com/kgoedecke/doop/pull/570); [#412](https://github.com/kgoedecke/doop/pull/412) (сжатие, подгрузка страниц и отсев iframe) закрыт, сжатие сокета он забрал в [#572](https://github.com/kgoedecke/doop/pull/572).
- [ ] На свежем `upstream/main` этой правки ещё нет. Автор так закрыл [#277](https://github.com/kgoedecke/doop/pull/277): прогнал тест автора на `main` и написал «already fixed». То же с открытыми PR и issue: если он уже делает это сам, PR не открывать.
- [ ] В ветке нет бренда Doop Dev, своего канала обновлений и `127.0.0.1:4437`. Нет `digital.akimov.doop-test`, пустого фида обновлений и прочих файлов форка (`doop-dev.tauri.json`, `docs/fork-workflow.md`, `.cursor/rules/git-workflow.mdc`).
- [ ] Есть связанный issue автора (`Fixes #N` / `Closes #N`). Без issue он тоже мержил ([#522](https://github.com/kgoedecke/doop/pull/522), [#544](https://github.com/kgoedecke/doop/pull/544)), но закрывает PR, если проблему уже закрыл сам.

### Ветка и коммиты

- [ ] Ветка от свежего `upstream/main`, не от форка `akimovdigital/doop` и не от `local/doop-dev`. Имя: `upstream/…`.
- [ ] Заголовок PR — Conventional Commits. PR вливается squash, и в коммит на `main` попадает заголовок, не сообщения ветки. CI гоняет `commitlint` по заголовку (`commit-message` в `ci.yml`). Типы из `CONTRIBUTING.md`: `feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `test`, `ci`, `perf`. Пример: `fix(desktop): update WebView2 for sharp canvas zoom`.
- [ ] Сообщения коммитов в том же формате: локальный `commit-msg` хук (husky + commitlint, `@commitlint/config-conventional`).

### Код

- [ ] Prettier: без точек с запятой, одинарные кавычки, 120 колонок (`bun run format`).
- [ ] `bun run lint` (oxlint с типами и узкий ESLint; предупреждения валят CI), `bun run typecheck`, `bun run format:check`, `bun run doc-lint`.
- [ ] Есть тест, который падает без правки. В принятых PR автор смотрит на имя файла и что именно покрыто ([#278](https://github.com/kgoedecke/doop/pull/278), [#439](https://github.com/kgoedecke/doop/pull/439), [#547](https://github.com/kgoedecke/doop/pull/547)).
- [ ] `bun install --frozen-lockfile` проходит: CI ставит зависимости только так.

### Описание

Отдельного шаблона нет. У принятых PR один и тот же каркас.

- [ ] **Проблема.** Что ломается и как повторить.
- [ ] **Что изменилось.** Один абзац на поведение, без списка несвязанных правок.
- [ ] **Проверка.** Команды, число тестов, ручной прогон (ОС, сборка).
- [ ] **Скриншоты и замер до/после**, если правка видна или про скорость. [#439](https://github.com/kgoedecke/doop/pull/439) — таблица миллисекунд до/после; [#540](https://github.com/kgoedecke/doop/pull/540) — видео и «до/после»; [#521](https://github.com/kgoedecke/doop/pull/521) — скриншот на узкой ширине в ответ на замечание. [#597](https://github.com/kgoedecke/doop/pull/597) дал цифры (средняя разница пикселей 4.64 → 1.72), скриншотов в теле нет, и PR всё ещё открыт.
- [ ] Ссылка на issue в теле.

### CI автора, CLA, Greptile

- [ ] Зелёные jobs из `.github/workflows/ci.yml`: `commit-message`, `typecheck`, `lint` (lint + format:check + doc-lint), `build`, четыре шарда `test`, сводный `tests`. Storybook в CI нет.
- [ ] Для десктопа ещё `.github/workflows/desktop.yml`. У первого внешнего PR с форка CI и Desktop остаются `action_required`, пока автор не нажмёт Approve workflows. Так сейчас у [#597](https://github.com/kgoedecke/doop/actions/runs/44980491952) и [#598](https://github.com/kgoedecke/doop/actions/runs/45005532018). Локально зелёное этому не замена: ждать его прогон.
- [ ] CLA подписан дословно, одним комментарием: `I have read the CLA Document and I hereby sign the CLA`. Бот — contributor-assistant, подписи в `signatures/cla.json` на ветке `cla-signatures`. Неподписанный PR не мержится (`CONTRIBUTING.md`). Allowlist: `kgoedecke`, боты, `Claude*`. Повторная проверка — комментарий `recheck`.
- [ ] Замечания Greptile (P1 в строке diff) закрыты кодом, потом автор часто пишет `@greptileai` и смотрит новый прогон. На [#521](https://github.com/kgoedecke/doop/pull/521) он смёржил после трёх прогонов: кнопки окна при «view as», возврат нативной рамки при ошибке загрузки, кнопки не перекрывают «Stop viewing». Оценка 5/5 с нулём комментариев сама по себе мерж не даёт: у [#597](https://github.com/kgoedecke/doop/pull/597) и [#598](https://github.com/kgoedecke/doop/pull/598) так и есть, оба открыты, Kevin не писал.

### Стоп

- [ ] Никита сказал «да». Только после этого открывать PR в `kgoedecke/doop`.
- [ ] В PR автору нет коммитов, комментариев и правок из `akimovdigital/doop`, которые относятся только к форку.
