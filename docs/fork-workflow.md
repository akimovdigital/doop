# Схема форка Doop Dev

Снимок снят 22 ноября 2026, 11:55 UTC командами `git fetch origin`, `git fetch upstream`, `git ls-remote`, `git rev-list` и `gh api`. Цифры ниже — из этого прогона. Код приложения не менялся.

Репозиторий: `akimovdigital/doop`, форк `kgoedecke/doop`, лицензия AGPL-3.0 (`gh repo view`, файл `LICENSE`). Ветка по умолчанию — `main`.

## Роли

| Ветка            | Где                        | Зачем                                                                                                                       |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `main` автора    | `kgoedecke/doop`           | Источник. Сейчас `8a53f23d` (2026-11-22 03:15:47 +0100), «feat(canvas): drawing a frame around shapes takes them in (#586)» |
| `main` форка     | `akimovdigital/doop`       | Зеркало `main` автора. Своих коммитов на нём нет                                                                            |
| `local/doop-dev` | форк                       | Наша сборка Doop Dev                                                                                                        |
| ветка PR автору  | от свежего `upstream/main` | Одна доработка без бренда Doop Dev, без своего канала обновлений и без `http://127.0.0.1:4437`                              |
| ветка форка      | от `local/doop-dev`        | Доработка, которая живёт только у нас                                                                                       |

Направление одно: `upstream/main` → `main` форка → `local/doop-dev`. Обратно, из `local/doop-dev` в `main` форка, не вливаем: иначе зеркало перестанет быть зеркалом.

Как часто: в начале работы с форком, не реже раза в день, пока автор коммитит так плотно. С 19 по 22 ноября `main` автора ушёл на 45 коммитов, а `main` форка остался на месте. `local/doop-dev` за это время синхронизировали отдельно.

## Где что стоит

`main` форка — `b2b4536e` (2026-11-19 01:13:07 −0800), «perf(canvas): stop restyling the whole page on every pan step (#439)».

От `upstream/main`: позади 45, впереди 0. `git merge-base` совпадает с `b2b4536e`, `b2b4536e` — предок `8a53f23d`. Это fast-forward, rebase не нужен.

От `local/doop-dev`: позади 79, впереди 0. Своих коммитов нет: 79 = 45 коммитов автора + 34 коммита сборки.

`local/doop-dev` — `059d3a55` (2026-11-22 14:18:57 +0300), «feat(desktop): open Doop Cloud alongside Local Dev». Диапазон после прошлого разбора: `ba9753fb` (2026-11-22 14:01:14 +0300) .. `059d3a55`, один коммит.

От `upstream/main`: позади 0, впереди 34. `8a53f23d` уже предок. Мерж в сборку сейчас пустой.

34 коммита — с `48d8c5aa` (2026-11-20 21:54:29 +0300, «chore: configure local Doop Dev builds») по `059d3a55`. Внутри два синка с автором: `0146a505` (2026-11-21 19:48:53 +0300) и `3ec33043` (2026-11-22 13:53:13 +0300, родители `7f2ca766` и `8a53f23d`). Дифф к `upstream/main`: 76 файлов, +6277 / −687. Уникальное: локальная оболочка Doop Dev, вкладки и группы, секции, панель Framework, ускорение холста, ручной вход, окно Doop Cloud.

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
- `desktop/src-tauri/src/dev_modes.rs` — меню Local Dev / Doop Cloud, только при identifier `digital.akimov.doop-test`
- `desktop/src-tauri/src/local_test_login.rs` — вход на `http://127.0.0.1:4437`

Правки общих файлов, которые держат локальный URL и тестовый identifier. В PR автору их вырезаем, при синке сборки сохраняем нашу сторону:

- `desktop/src-tauri/capabilities/default.json` — remote URL заменён на `http://127.0.0.1:4437`
- `desktop/src-tauri/src/updates.rs` — обновление разрешено только identifier `design.doop.desktop` и адресу `https://doop.design` / `https://www.doop.design`
- `desktop/src-tauri/src/main.rs` — вызовы `dev_modes`

`updates.rs` при этом полезен и автору: официальный фид не должен ставиться на чужой identifier. В такой PR брать логику, а тест с `digital.akimov.doop-test` и локальный URL оставлять в форке.

## Версия

Политика: номер оболочки Dev равен авторскому. На этом снимке и `upstream/main`, и `local/doop-dev` имеют `0.14.0` в `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` и `desktop/src-tauri-chromium/Cargo.toml`. `package.json` на обоих — `0.15.0`: это номер приложения, он тоже совпадает с автором.

Серию `0.0.x` в `doop-dev.tauri.json` не возвращаем. Сборки отличаем identifier, пустым каналом обновлений и SHA. Когда понадобится метка именно нашей сборки, ставим свой тег на `local/doop-dev`, например `doop-dev/059d3a55`. Имена `v0.14.0` и `desktop-v0.14.0` принадлежат автору.

Когда автор поднимет номер оболочки, Dev повторяет этот номер в базовых файлах. Отдельный меньший номер в оверлее не заводим.

## Окно Doop Cloud

Коммит `059d3a55` добавляет в сборку с identifier `digital.akimov.doop-test` пункт Window: Local Dev и Doop Cloud. Doop Cloud открывает `https://doop.design/auth` во втором окне, со своим хранилищем сайта и обычным заголовком macOS (`desktop/src-tauri/src/dev_modes.rs`, абзац в `DESIGN.md`).

Для схемы это лишнее. Официальное приложение автора уже клиент облака: identifier `design.doop.desktop`, productName `doop`, канал `https://doop.design/desktop/latest.json`, сервер по умолчанию `https://doop.design` (`desktop/src-tauri/src/server.rs`, меню «Use doop.design…», когда выбран другой сервер). Второе окно в тестовой оболочке повторяет этот клиент без официального канала и без identifier автора. В PR автору оно не идёт. В роли веток его нет: Doop Dev остаётся локальной сборкой на `127.0.0.1:4437`, облако остаётся официальным приложением.

Коммит не откатываем. Убрать окно можно позже отдельным коммитом на `local/doop-dev`, команда в конце, сейчас её не запускать.

## Инвентарь `akimovdigital/doop`

`gh api repos/akimovdigital/doop/branches` и `git ls-remote --heads origin` — две ветки:

| Ветка            | SHA        | Дата коммита              | От `upstream/main`   | От `local/doop-dev`  | Уникальное                          |
| ---------------- | ---------- | ------------------------- | -------------------- | -------------------- | ----------------------------------- |
| `main`           | `b2b4536e` | 2026-11-19 01:13:07 −0800 | позади 45, впереди 0 | позади 79, впереди 0 | ничего, старый `main` автора        |
| `local/doop-dev` | `059d3a55` | 2026-11-22 14:18:57 +0300 | позади 0, впереди 34 | —                    | 34 коммита сборки поверх `8a53f23d` |

`git ls-remote --tags origin` пуст. `gh api repos/akimovdigital/doop/tags` пуст. `gh release list` пуст. `actions/artifacts` и `actions/runs` — `total_count` 0.

PR: `gh pr list --repo akimovdigital/doop --state all` пуст; поиск `repo:akimovdigital/doop is:pr` — 0. Поиск `repo:kgoedecke/doop author:akimovdigital is:pr` — 0. Поиск `repo:kgoedecke/doop head:akimovdigital is:pr` — 0. Открытых и закрытых PR форка и наших PR автору нет.

У автора `git ls-remote --tags` даёт 41 строку и 35 имён тегов (`v0.1.0`…`v0.15.0`, `desktop-v0.1.0`…`desktop-v0.14.0`, `desktop-updates`, `canva-review-demo`). Они остаются у автора. В форк их не копируем и у автора не удаляем.

Ветка `chore/fork-workflow` в снимок не входит: на ней только этот документ.

## Оставить, удалить, слить

| Объект                      | Решение                                       | Почему                                                                        |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `main` форка                | Слить fast-forward до `8a53f23d`              | Позади на 45, впереди на 0, своих коммитов нет. Пуш в этом запуске не делался |
| `local/doop-dev`            | Оставить                                      | Наша сборка. `8a53f23d` уже внутри, мержить сейчас нечего                     |
| `chore/fork-workflow`       | Влить в `local/doop-dev`, потом ветку удалить | Только этот документ. После мержа ветка не нужна                              |
| теги форка                  | Удалять нечего                                | Тегов нет                                                                     |
| теги автора (35 имён)       | Оставить у автора                             | Чужие релизы. В форк не зеркалировать                                         |
| релизы и артефакты форка    | Удалять нечего                                | Списков нет                                                                   |
| PR                          | Удалять и закрывать нечего                    | PR нет ни в форке, ни в `kgoedecke/doop` от `akimovdigital`                   |
| окно Doop Cloud, `059d3a55` | Оставить код                                  | Лишнее для схемы, но этот запуск ничего не удаляет                            |

Лишних веток, копий и сборок на форке нет. Единственное отставание — `main`.

## Команды синка

Ниже команды для своего компьютера. В этом запуске выполнен только пуш `chore/fork-workflow`. `main` не пушился, ветки и теги не удалялись.

Один раз:

```bash
git remote add upstream https://github.com/kgoedecke/doop.git
```

Каждый синк. Сначала зеркало, потом сборка. Если первая проверка не равна 0, `main` форка уже не зеркало: остановиться и разобрать коммиты, fast-forward не делать.

```bash
git fetch upstream
git fetch origin

git rev-list --count upstream/main..origin/main
git rev-list --count origin/main..upstream/main

git push origin upstream/main:refs/heads/main

git checkout local/doop-dev
git merge upstream/main
```

На снимке 22.11.2026 первая проверка даёт 0, вторая — 45. После fast-forward `main` встанет на `8a53f23d`. `git merge upstream/main` в `local/doop-dev` напишет, что всё уже слито: этот SHA предок `059d3a55`.

Ветка для PR автору:

```bash
git fetch upstream
git checkout -b <тема> upstream/main
```

Не переносить `doop-dev.tauri.json`, `build-doop-dev.sh`, `DESIGN.md`, `dev_modes.rs`, `local_test_login.rs`, иконки `doop-test-dev` и замену remote URL на `127.0.0.1:4437`.

Ветка форка:

```bash
git checkout local/doop-dev
git checkout -b <тема>
```

Свой тег сборки, когда он понадобится. Сейчас не ставить: тегов в форке нет, и этот запуск их не создаёт.

```bash
git checkout local/doop-dev
git tag doop-dev/059d3a55 059d3a55b663d64c3a375f8a417073253b0ff1db
git push origin doop-dev/059d3a55
```

## Команды удаления

Сейчас не запускать. Удалять нечего: обе ветки нужны, тегов нет.

Шаблон на будущий дубль. `main` и `local/doop-dev` в него не подставлять.

```bash
git push origin --delete <имя-ветки>
git push origin :refs/tags/<имя-тега>
```

Окно Doop Cloud убрать только отдельным решением, не в этом запуске:

```bash
git checkout local/doop-dev
git revert --no-edit 059d3a55b663d64c3a375f8a417073253b0ff1db
```

После принятия этого документа ветку документа удалить так:

```bash
git push origin --delete chore/fork-workflow
```

Это после мержа в `local/doop-dev`, не раньше.
