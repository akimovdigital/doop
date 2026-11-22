# Журнал уроков

Формат записи: дата, PR или синк со ссылкой, что сделали, что сработало, что сломалось и причина, урок или правило на будущее. Причину не выдумывать. Повторяющийся урок переносить правилом в `.cursor/rules/git-workflow.mdc`.

## 22.11.2026 — синк `main`

Синк: fast-forward `main` форка [`b2b4536e`](https://github.com/akimovdigital/doop/commit/b2b4536e066118829344bd1ae8264fa370093ea4) → [`8a53f23d`](https://github.com/akimovdigital/doop/commit/8a53f23d2fb71394279c4d1476eb830befb50995).

**Что сделали.** `main` форка перемотан до `upstream/main` обычным push, без force.

**Что сработало.** Перед push впереди было 0: `upstream/main..origin/main` = 0, своих коммитов на `main` не было.

**Что сломалось.** Ничего.

**Урок.** Перед перемоткой проверять `upstream/main..origin/main` = 0. Если впереди не 0, `main` уже не зеркало: остановиться и разобрать коммиты, fast-forward не делать.

## 22.11.2026 — revert окна Doop Cloud и PR #1

Revert: [`0ad297ca`](https://github.com/akimovdigital/doop/commit/0ad297ca4b5b84724bfce49921762de2e58d464f) откатил [`059d3a55`](https://github.com/akimovdigital/doop/commit/059d3a55b663d64c3a375f8a417073253b0ff1db) («feat(desktop): open Doop Cloud alongside Local Dev»).

PR: [#1](https://github.com/akimovdigital/doop/pull/1), схема веток, merge [`4989a4bd`](https://github.com/akimovdigital/doop/commit/4989a4bda79b6bf4efe2d74e35274d7f2839f03e).

**Что сделали.** До PR #1 окно Doop Cloud снято с `local/doop-dev`. PR #1 записал схему веток форка.

**Что сработало.** Окно было лишним: официальное приложение автора уже клиент облака.

**Что сломалось.** Второе окно в тестовой оболочке повторяло облако автора. Причина: официальное приложение уже этот клиент, отдельное окно в Doop Dev его дублировало.

**Урок.** Не дублировать облако автора во второй оболочке.

## 22.11.2026 — PR #2, правила Git

PR: [#2](https://github.com/akimovdigital/doop/pull/2), SHA [`433808c`](https://github.com/akimovdigital/doop/commit/433808c7241df823adddfd9e8e9a96a11c279a9c).

**Что сделали.** Зафиксировали правила Git: `.cursor/rules/git-workflow.mdc`, `AGENTS.md`, `docs/fork-workflow.md`.

**Что сработало.** Правило, `AGENTS.md`, `docs/fork-workflow.md`, слияние squash. Vitest на этой правке новых падений не добавил.

**Что сломалось.** Ничего нового от этой правки. Десять падений, которые уже были, записаны следующей записью.

**Урок.** Правка правил живёт в этих трёх файлах и сливается squash. Сама по себе она падений vitest не добавляет.

## 22.11.2026 — vitest, 10 падений

**Что сделали.** Сверили падения на revert `0ad297ca` и на PR #2. Веб-код между ними не менялся.

**Что сработало.** Набор падений на этих двух точках один и тот же, правка PR #2 его не расширила.

**Что сломалось.** 10 падений: `componentsBrowser` 6, `drawingShapesBrowser` 1, `pagesSplitBrowser` 3.

**Причина.** Файла с разбором, падают ли они на чистом `8a53f23`, нет. Падения есть на нашей ветке, причина ещё не отделена от upstream.

**Урок.** Новые падения добавлять нельзя.

## 22.11.2026 — чужие PR #597 и #598

PR автора: [#597](https://github.com/kgoedecke/doop/pull/597) и [#598](https://github.com/kgoedecke/doop/pull/598). Оба ещё open, Kevin не комментировал.

**Что сделали.** Разобрали, как выглядит первый PR с чужого форка. Чек-лист уже в `docs/fork-workflow.md` после [PR #3](https://github.com/akimovdigital/doop/pull/3).

**Что сработало.** Чек-лист записан у нас. PR в `kgoedecke/doop` из этих уроков не открывали.

**Что сломалось.** CI первого PR с чужого форка остаётся `action_required`, пока автор не одобрит workflow. Greptile 5/5 у обоих есть, и оба всё ещё открыты.

**Урок.** CLA — дословная фраза `I have read the CLA Document and I hereby sign the CLA`. Оценка Greptile 5/5 мерж не означает.

## 22.11.2026 — Doop Dev и официальный Doop

Сравнение установленного `/Applications/doop.app` и Doop Dev.app. Оба приложения `0.14.0`. Меню File одинаковое.

**Что сделали.** Сверили диалог Import и коммит, из которого собран установленный Doop Dev.app.

**Что сработало.** Меню File совпадает. У Doop Dev в Import есть Website, Live app и GitHub repo. `importSourceList.tsx` форк не менял. Кнопка Connect GitHub на локальном сервере выключена, потому что в окружении нет `GITHUB_APP_*`. Запасной путь через токен остаётся.

**Что сломалось.** В диалоге Import у официального doop.design есть Website, Figma, Storybook, Illustrator, Photoshop, Live app, GitHub и Canva. У Doop Dev нет Figma, Storybook, Illustrator, Photoshop и Canva. Установленный Doop Dev.app собран около [`059d3a55`](https://github.com/akimovdigital/doop/commit/059d3a55b663d64c3a375f8a417073253b0ff1db) и всё ещё содержит окно Doop Cloud. В git это окно уже снято revert [`0ad297ca`](https://github.com/akimovdigital/doop/commit/0ad297ca4b5b84724bfce49921762de2e58d464f).

**Причина.** Строк Figma, Storybook, Illustrator, Photoshop и Canva нет в публичном `upstream/main` [`8a53f23`](https://github.com/akimovdigital/doop/commit/8a53f23d2fb71394279c4d1476eb830befb50995) и в форке. Они есть в живом бандле `doop.design/assets` (Last-Modified 2026-11-22). Окно Doop Cloud в установленном приложении осталось от сборки около `059d3a55`, не от текущего git.

**Урок.** Не равнять установленный Doop Dev.app и живой бандл doop.design с `origin/local/doop-dev` и публичным `upstream/main`. Секреты окружения не читать и не коммитить.
