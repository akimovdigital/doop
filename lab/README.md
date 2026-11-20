# Doop + Stacki Test для Мака

Постоянный вход — `~/Applications/Doop + Stacki Test.app`. Открой в Finder. Когда появится холст, нажми «Stacki». В Navigator раскрой `html → body → main`. У `h1` текст находится в Content, у `img` адрес находится в Settings → Attributes → src. Два доступных изображения имеют адреса `/images/forest.jpg` и `/images/hills.jpg`. Дождись Saved, закрой окно и снова открой приложение. Сначала откроется Doop, в режим Stacki переходишь кнопкой.

При первом переносе утверди исходный тестовый фрейм через Development → Mark as approved, затем нажми «Stacki». Повторное переключение открывает сохранённые правки Astro. Источник страницы — `site/src/pages/index.astro`.

## Сборка

Версия 0.1.0, сборка 1, Apple Silicon. Идентификатор `digital.akimov.doop-stacki-test`. Приложение использует установленный Node 24.16.0 и файлы текущего worktree. Doop хранит локальный проект в `~/Library/Application Support/Doop Stacki Test`. Astro и Studio живут в `lab/site`. Приложение запускает оба сервиса на `127.0.0.1` и останавливает при закрытии окна.

Основа — Doop `b2b4536`, Stacki Studio 1.4.8 из Stacki `6e862b4764f791c910c1f3ee7f2a0b5bab07622f`, Astro 7.3.8 и Electron 45.4.1. Для пересборки нужны зависимости Doop из `bun.lock` и результат `bun run build`. Для Studio из указанного коммита выполни `npm ci` и `npm run build` в `studio/`, скопируй `dist` в `lab/vendor/studio` и его зависимости в `lab/vendor/node_modules`. Для Astro установи зависимости из `lab/site/package-lock.json`. Для оболочки установи зависимости из `lab/shell/package-lock.json` и запусти `node lab/shell/node_modules/electron/install.js`. `lab/build-app.sh` принимает новый путь и собирает подписанный локально пакет.

[Локальный Stacki Studio](https://github.com/flowtricks/stacki/blob/main/studio/README.md#run-locally) · [Передача фрейма Doop](https://doop.design/docs/handoff#hand-the-code-over)
