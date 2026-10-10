<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Beatstore

- Один продавец, русский интерфейс, RUB. Демонстрационный MVP с тестовыми платежами.
- Основные требования: `docs/requirements.md`; схема: `docs/data-model.md`; запуск: `README.md`.
- TypeScript используется для интерфейса, серверного кода и скриптов. Деньги — целые копейки, проценты — точные десятичные значения.
- Сервер определяет цены и проверяет доступ к данным и файлам. Не выдавать WAV, ZIP и документы через публичный маршрут превью.
- Сохранять версии условий и файлов покупок. Не редактировать применённые SQL-миграции, добавлять новые.
- PGlite используется одним процессом. Не запускать миграции или seed одновременно с локальным приложением. Не удалять рабочую базу для исправления ошибки.
- Проверки: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Конкурентные сценарии покупки проверяются на отдельном PostgreSQL.
- Автор и коммитер изменений — `sry4thedlyy`, email `335511881+sry4thedlyy@users.noreply.github.com`. Префикс новых веток — `sry4thedlyy/`.
- Документация описывает продукт, решения и ограничения, без истории переписки и подтверждений.
