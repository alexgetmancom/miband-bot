# miband-bot

Русский | [English](README_EN.md) | [Español](README.es-ES.md)

Личный self-hosted Telegram-бот для данных Xiaomi Fitness / Mi Band.

Забирает шаги, сон, пульс, SpO2, стресс, суточную активность, вес
и тренировки из облака Xiaomi Fitness, хранит их в локальной SQLite-базе
и даёт доступ к ним прямо из Telegram —
без сторонних сервисов и без передачи данных третьим лицам.

> **Проект рассчитан на одного владельца.**
> Это не публичный бот и не медицинский сервис.

## Возможности

- Просмотр последних шагов, сна, пульса, SpO2, стресса, веса и тренировок в Telegram.
- Ручная и автоматическая синхронизация по расписанию.
- Автообновление закреплённого главного сообщения после фоновой синхронизации.
- Хранение истории в SQLite (`data/`).
- Экспорт всех таблиц в ZIP с CSV-файлами прямо в чат.
- Развёртывание через Docker Compose.
- Атомарная запись Xiaomi-токена с правами `0600`.
- Умная автопривязка к первому пользователю (whitelist).

## Как это работает

```text
Mi Band → Xiaomi Fitness cloud → miband-bot → SQLite → Telegram / CSV
```

Docker Compose запускает два процесса:

- `tracker` — периодически синхронизирует данные из Xiaomi Fitness;
- `fitness-bot` — обслуживает Telegram-меню, ручной sync и экспорт.

Оба процесса работают с одной папкой `./data`. Конкурентная запись
исключена файловым lock-ом.

## Требования

- Docker и Docker Compose (или установленный Python 3.11+).
- Telegram bot token от [@BotFather](https://t.me/BotFather).
- Аккаунт Xiaomi с данными Xiaomi Fitness.

## Быстрый запуск

### Способ 1: Бесшовная установка в один клик (Рекомендуется)

Если у вас еще нет проекта на компьютере, вы можете автоматически скачать и настроить его одной командой в терминале:

- **macOS / Linux:**
  ```sh
  curl -fsSL https://raw.githubusercontent.com/iAlexeyRu/miband-bot/main/install.sh | bash
  ```
- **Windows (PowerShell):**
  ```powershell
  powershell -c "irm https://raw.githubusercontent.com/iAlexeyRu/miband-bot/main/install.ps1 | iex"
  ```

Установщик сам создаст папку `miband-bot`, загрузит и распакует файлы проекта, проверит окружение и запустит интерактивную настройку!
Повторный запуск этой же PowerShell-команды в уже настроенной установке обновит файлы и сразу запустит бота без повторного ввода токена.

---

### Способ 2: Запуск из скачанной папки

Если вы уже склонировали репозиторий через `git clone` или скачали архив вручную:

- **macOS / Linux:**
  ```sh
  ./setup.sh
  ```
- **Windows:**
  Запустите двойным кликом файл `setup.bat` или выполните в консоли:
  ```cmd
  setup.bat
  ```

Скрипт сам проверит окружение, пошагово поможет получить токен, создаст конфигурацию `secrets.env`, развернет окружение Python (если выбран запуск без Docker) и предложит запустить бота одной кнопкой.
После настройки бот можно запускать повторно через `run_local.sh` на macOS/Linux или `run_local.bat` на Windows из папки `miband-bot`.

---

### Способ 3: Полностью ручная настройка (manual setup):

1. Скопируйте шаблон конфигурации:
   ```sh
   cp secrets.env.example secrets.env
   ```
2. Укажите ваш `TELEGRAM_BOT_TOKEN` в файле `secrets.env`. Переменную `TELEGRAM_ALLOWED_USER_ID` **оставьте пустой** — бот автоматически привяжется к вам при первом старте.
3. Запустите Docker контейнеры:
   ```sh
   docker compose up -d --build
   ```
4. Откройте вашего созданного бота в Telegram и отправьте ему команду `/start` — бот распознает ваш аккаунт, привяжет его как единственного владельца и начнет синхронизацию!

## Настройки

Все переменные — в `secrets.env`:

| Переменная                 | По умолчанию | Описание                                |
| -------------------------- | ------------ | --------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | —            | Token Telegram-бота                     |
| `TELEGRAM_ALLOWED_USER_ID` | —            | Разрешённый user id (оставьте пустым для автопривязки) |
| `SYNC_INTERVAL`            | `900`        | Интервал фоновой синхронизации, секунды |
| `QUERY_DURATION`           | `2`          | Глубина запроса при sync, дней          |
| `ENABLE_FDS_SLEEP_DETAILS` | `true`       | Загружать детальные ночные данные FDS   |

Пути к базе и статусу заданы в `compose.yaml`. При запуске без Docker
смотрите `secrets.env.example`.

## Файлы данных

Runtime-файлы создаются в `./data`:

| Файл                   | Содержимое                        |
| ---------------------- | --------------------------------- |
| `token_<id>.json`      | Xiaomi auth token (**секретный**) |
| `miband_<id>.db`       | SQLite-база с health-данными      |
| `status_<id>.json`     | Последний статус синхронизации    |
| `allowed_user.id`      | ID привязанного владельца         |
| `fitness_bot_state.db` | Служебное состояние Telegram-меню |
| `sync_<id>.lock`       | Lock-файл синхронизации           |

`secrets.env`, `data/`, `*.db`, `token*.json` и `status*.json`
добавлены в `.gitignore` — не коммитьте их.

## Команды

| Команда   | Действие                              |
| --------- | ------------------------------------- |
| `/start`  | Открыть меню или начать вход в Xiaomi |
| `/sync`   | Запустить ручную синхронизацию        |
| `/status` | Показать состояние локальной базы     |

## Локальная разработка

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt -e mi-fitness-python
.venv/bin/python -m py_compile fitness_bot.py miband_sync.py \
    $(find miband_tracker -name '*.py' | sort)
.venv/bin/python -m pytest
.venv/bin/python -m pytest mi-fitness-python/tests/unit
.venv/bin/ruff check .
.venv/bin/python -m pip check
```

Точки входа:

```sh
python -u miband_sync.py      # или: miband-sync
python -u fitness_bot.py      # или: miband-fitness-bot
```

## Troubleshooting

**Бот не отвечает** — проверьте `TELEGRAM_BOT_TOKEN`, логи, а также убедитесь, что вы первыми отправили `/start` боту для привязки. При необходимости сбросить привязанного владельца просто удалите файл `data/allowed_user.id` и отправьте `/start` снова.

```sh
docker compose logs -f fitness-bot
```

**Token не найден** — отправьте `/start` и пройдите Xiaomi login flow.

**Token истёк** — запустите повторный вход из меню; старый файл
можно удалить из `data/`.

**Нет SpO2 или деталей сна** — убедитесь, что эти данные отображаются
в самом приложении Xiaomi Fitness. Доступность зависит от модели
браслета и настроек шаринга.

**После обновления Xiaomi всё сломалось** — это ожидаемый риск
при работе с неофициальным API. Проверьте issues и логи, затем
обновите код или временно отключите проблемный модуль.

## Важно: reverse engineering и ограничения

`miband-bot` — неофициальный проект, не связанный с Xiaomi, Zepp,
Huami или Telegram.

Доступ к данным реализован через reverse engineering закрытых API,
поэтому:

- Xiaomi может изменить API без предупреждения;
- авторизация или синхронизация могут временно не работать;
- используйте проект только со своими аккаунтами и данными;
- соблюдайте законодательство и условия использования сервисов;
- данные браслета не являются медицинским заключением.

## Лицензия

Проект распространяется под [GNU GPL v3.0 or later](LICENSE).

SDK `mi-fitness-python` включён как vendored source copy под
[GNU GPL v3.0](mi-fitness-python/LICENSE). Подробности — в
[VENDORED.md](VENDORED.md).
