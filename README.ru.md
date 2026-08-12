# miband-bot

[Русский](README.ru.md) | [English](README.md) | [Español](README.es-ES.md)

Личный self-hosted Telegram-бот для данных Xiaomi Fitness и Mi Band.

Он синхронизирует шаги, сон, пульс, SpO2, стресс, суточную активность, вес
и тренировки в локальные SQLite-файлы, а смотреть и экспортировать их можно прямо
из Telegram. Данные не уходят в сторонние сервисы.

> Проект рассчитан на одного владельца. Это не публичный бот и не медицинский сервис.

## Возможности

- Сводки за день, история, недельные отчёты, тренды, семейная статистика и сравнения.
- QR-вход Xiaomi и ручная или плановая синхронизация.
- Экспорт CSV/ZIP из Telegram.
- По умолчанию интерфейс на английском; русский и испанский включаются в Settings.
- Bun/TypeScript runtime и Docker Compose.

## Быстрый запуск

`
cp .env.example secrets.env
# Укажите TELEGRAM_BOT_TOKEN в secrets.env
bun install
bun run check
docker compose up -d --build
`

Рабочие данные находятся в `./data`. Файлы `secrets.env`, `data/`, токены Xiaomi,
SQLite-базы и экспорты должны оставаться приватными.

## Разработка

`
bun install
bun run check
bun run dev
`

Сервис открывает `/healthz` и `/readyz` на порту `8080`.

## Лицензия

[GNU GPL v3.0 или новее](LICENSE).
