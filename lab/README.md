# Doop + Stacki Test для Мака

Постоянный вход — `~/Applications/Doop + Stacki Test.app`. Открой приложение из Finder.

1. Нажми «Новый пример». Приложение откроет свежий холст Doop и выделит тестовый фрейм. Если уже открыт черновик с подсказкой в верхней панели, можно начать с него.
2. В правой панели Doop включи **Development → Mark as approved**. На фрейме появится **Ready for dev**.
3. Нажми **Stacki**. Откроется страница `example-N`, где `N` — номер холста в верхней панели.
4. В **Navigator** раскрой `html → body → main`. У `h1` текст находится в **Content**, у `img` адрес находится в **Settings → Attributes → src**. Для замены фото укажи `/examples/N/images/hills.jpg` вместо `/examples/N/images/forest.jpg`. Замени `N` номером своего примера.
5. Дождись **Saved**, закрой и снова открой приложение. Нажми **Stacki**, чтобы открыть сохранённый пример. В разделе **Pages** открой **Home** для исходной страницы или выбери любой ранее перенесённый пример.

Пример 1 хранится в `site/src/pages/index.astro`. Новые примеры хранятся в `site/src/pages/example-N.astro`, их стили и изображения — в `site/public/examples/N/`.

## Сборка

Версия 0.2.0, сборка 2, Apple Silicon. Идентификатор `digital.akimov.doop-stacki-test`. Приложение использует установленный Node 24.16.0 и файлы текущего worktree. Doop хранит локальный проект в `~/Library/Application Support/Doop Stacki Test`. Astro и Studio живут в `lab/site`. Приложение запускает оба сервиса на `127.0.0.1` и останавливает при закрытии окна.

Основа — Doop `b2b4536`, Stacki Studio 1.4.8 из Stacki `6e862b4764f791c910c1f3ee7f2a0b5bab07622f`, Astro 7.3.8 и Electron 45.4.1. Для пересборки нужны зависимости Doop из `bun.lock` и результат `bun run build`. Для Studio из указанного коммита выполни `npm ci` и `npm run build` в `studio/`, скопируй `dist` в `lab/vendor/studio` и его зависимости в `lab/vendor/node_modules`. Для Astro установи зависимости из `lab/site/package-lock.json`. Для оболочки установи зависимости из `lab/shell/package-lock.json` и запусти `node lab/shell/node_modules/electron/install.js`. `lab/build-app.sh` принимает новый путь и собирает подписанный локально пакет.

[Локальный Stacki Studio](https://github.com/flowtricks/stacki/blob/main/studio/README.md#run-locally) · [Передача фрейма Doop](https://doop.design/docs/handoff#hand-the-code-over)
