# Security Policy

`miband-bot` handles Telegram credentials, Xiaomi auth tokens and health data. Treat every runtime file as private.

## Supported Scope

Security reports are accepted for the current `main` branch. This is a small self-hosted project, so there are no formal long-term support branches.

## Sensitive Files

By default, Docker Compose stores runtime data under `./data`:

- `secrets.env` contains the Telegram bot token and access configuration.
- `data/token_<telegram_user_id>.json` contains Xiaomi auth credentials.
- `data/miband_<telegram_user_id>.db` contains health history.
- `data/status_<telegram_user_id>.json` contains latest sync state.
- `data/fitness_bot_state.db` contains Telegram menu state.

These files must not be committed, uploaded to public issue trackers, or pasted into logs. Token files are written atomically with mode `0600`, but filesystem permissions are not a substitute for keeping the host private.

## Telegram Export Privacy

The CSV export feature sends a ZIP with health data through Telegram. Use it only in your own private chat with your bot. Do not forward exports to shared chats unless you intentionally want other people to access that data.

## Rotating Secrets

- Telegram bot token: revoke or regenerate it with [@BotFather](https://t.me/BotFather), then update `secrets.env` and restart Compose.
- Xiaomi token: delete `data/token_<telegram_user_id>.json`, then open the bot and run the Xiaomi login flow again.
- Local health data: stop Compose and remove the relevant `data/*.db`, `data/status*.json` and `data/token*.json` files.

## Reporting A Vulnerability

Open a private report if the hosting platform supports it, or contact the maintainer directly before publishing details. Do not include real tokens, Telegram user ids, Xiaomi account ids, database dumps or health exports in the report.

Useful safe context includes:

- project commit;
- Bun and Docker versions;
- sanitized logs with tokens removed;
- exact steps to reproduce using placeholder credentials.

## Reverse Engineering Notice

This project uses unofficial Xiaomi Fitness APIs discovered through reverse engineering. Do not use it to access accounts or data that you do not own or have explicit permission to use.
