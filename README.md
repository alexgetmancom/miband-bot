# miband-bot

[Русский](README.ru.md) | English | [Español](README.es-ES.md)

Self-hosted Telegram bot for Xiaomi Fitness and Mi Band health data.

It synchronizes steps, sleep, heart rate, SpO2, stress, daily activity, weight,
and workouts into local SQLite files and lets you view or export them from Telegram.
No third-party data service is involved.

> Designed for one private owner. Not a public bot or a medical service.

## Features

- Daily health summaries, history, weekly reports, trends, family stats, and comparisons.
- Xiaomi QR login and scheduled or manual synchronization.
- CSV/ZIP export from Telegram.
- English interface by default, with Russian and Spanish switchers in Settings.
- Bun/TypeScript runtime with Docker Compose.

## Quick start

```
cp .env.example secrets.env
# Set TELEGRAM_BOT_TOKEN in secrets.env
bun install
bun run check
docker compose up -d --build
```

Runtime data is stored in `./data`. Keep `secrets.env`, `data/`, Xiaomi tokens,
SQLite databases, and exports private.

## Development

```
bun install
bun run check
bun run dev
```

The service exposes `/healthz` and `/readyz` on port `8080`.

## Production

The VM-106 deployment uses the existing `/opt/miband-tracker` directory and the
`compose.vm106.yaml` file. Production images are published to GHCR and activated by
`.github/workflows/cd.yml` as immutable digests. Enable its deploy job with repository variable
`DEPLOY_ENABLED=true` and the secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_PRIVATE_KEY`, and
`DEPLOY_KNOWN_HOSTS`. Keep `/opt/miband-tracker/secrets.env` and `/opt/miband-tracker/data` on the
server; the workflow does not copy either one.

## License

[GNU GPL v3.0 or later](LICENSE).
