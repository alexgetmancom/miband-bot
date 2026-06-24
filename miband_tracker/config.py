# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alexey

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_local_env(filename: str = "secrets.env") -> None:
    """Load KEY=VALUE pairs from a local .env file into os.environ.

    Only sets variables that are NOT already present in the environment
    (explicit env always wins). Skips blank lines and comments (#).
    """
    env_file = Path(filename)
    if not env_file.exists():
        return
    try:
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key and key not in os.environ:
                os.environ[key] = value.strip()
    except Exception:
        pass  # Never crash on env-file read failure


class ConfigError(ValueError):
    """Invalid runtime configuration."""


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, min_value: int | None = None) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} должен быть целым числом") from exc
    if min_value is not None and value < min_value:
        raise ConfigError(f"{name} должен быть не меньше {min_value}")
    return value


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    db_path: Path
    status_path: Path
    bot_state_db_path: Path
    telegram_bot_token: str
    telegram_allowed_user_ids: list[int] = field(default_factory=list)
    sync_interval: int = 900
    query_duration: int = 2
    enable_fds_sleep_details: bool = True
    telegram_allowed_user_id: int | None = None

    def __post_init__(self) -> None:
        if self.telegram_allowed_user_id is not None and not self.telegram_allowed_user_ids:
            object.__setattr__(self, "telegram_allowed_user_ids", [self.telegram_allowed_user_id])
        elif self.telegram_allowed_user_ids and self.telegram_allowed_user_id is None:
            object.__setattr__(self, "telegram_allowed_user_id", self.telegram_allowed_user_ids[0])

    @classmethod
    def from_env(cls, *, require_bot: bool = False) -> Settings:
        # Load local secrets.env (if present) before reading env vars.
        # This makes Python the single source of truth on all platforms.
        _load_local_env()
        # Auto-detect local vs Docker mode: if DATA_DIR is not set, use ./data
        # when running locally (secrets.env present or ./data already exists),
        # otherwise fall back to the Docker default /opt/miband-tracker/data.
        _default_data = (
            "./data"
            if (Path("secrets.env").exists() or Path("data").is_dir())
            else "/opt/miband-tracker/data"
        )
        data_dir = Path(os.environ.get("DATA_DIR", _default_data))
        
        # Read from TELEGRAM_ALLOWED_USER_IDS or legacy TELEGRAM_ALLOWED_USER_ID
        raw_ids = os.environ.get("TELEGRAM_ALLOWED_USER_IDS", os.environ.get("TELEGRAM_ALLOWED_USER_ID", ""))
        allowed_user_ids = parse_user_ids(raw_ids, required=False)

        # Если ID не задан в env, пробуем загрузить из файла allowed_user.id
        allowed_user_file = data_dir / "allowed_user.id"
        if not allowed_user_ids and allowed_user_file.exists():
            try:
                raw_file = allowed_user_file.read_text(encoding="utf-8").strip()
                allowed_user_ids = parse_user_ids(raw_file)
            except Exception:
                pass

        bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        if require_bot and not bot_token:
            raise ConfigError("TELEGRAM_BOT_TOKEN не задан")
        return cls(
            data_dir=data_dir,
            db_path=Path(os.environ.get("DB_PATH", str(data_dir / "miband.db"))),
            status_path=Path(os.environ.get("STATUS_PATH", str(data_dir / "status.json"))),
            bot_state_db_path=Path(
                os.environ.get(
                    "BOT_STATE_DB_PATH",
                    str(data_dir / "fitness_bot_state.db"),
                )
            ),
            telegram_bot_token=bot_token,
            telegram_allowed_user_ids=allowed_user_ids,
            sync_interval=_env_int("SYNC_INTERVAL", 900, min_value=0),
            query_duration=_env_int("QUERY_DURATION", 2, min_value=1),
            enable_fds_sleep_details=_env_bool("ENABLE_FDS_SLEEP_DETAILS", default=True),
        )

    def require_user_id(self, user_id: int | None = None) -> int:
        resolved = user_id if user_id is not None else self.telegram_allowed_user_id
        if resolved is None:
            raise ConfigError("Нет доступных пользователей (TELEGRAM_ALLOWED_USER_IDS пуст)")
        return int(resolved)

    def token_path(self, user_id: int | None = None) -> Path:
        uid = self.require_user_id(user_id)
        preferred = self.data_dir / f"token_{uid}.json"
        legacy = self.data_dir / "token.json"
        if preferred.exists() or not legacy.exists():
            return preferred
        return legacy

    def user_db_path(self, user_id: int | None = None) -> Path:
        uid = self.require_user_id(user_id)
        preferred = self.data_dir / f"miband_{uid}.db"
        if preferred.exists():
            return preferred
        return self.db_path

    def user_status_path(self, user_id: int | None = None) -> Path:
        uid = self.require_user_id(user_id)
        preferred = self.data_dir / f"status_{uid}.json"
        if preferred.exists():
            return preferred
        return self.status_path

    def canonical_user_db_path(self, user_id: int | None = None) -> Path:
        return self.data_dir / f"miband_{self.require_user_id(user_id)}.db"

    def canonical_user_status_path(self, user_id: int | None = None) -> Path:
        return self.data_dir / f"status_{self.require_user_id(user_id)}.json"


def parse_user_ids(raw: str, *, required: bool = False) -> list[int]:
    values = [item.strip() for item in raw.split(",") if item.strip()]
    if not values:
        if required:
            raise ConfigError("TELEGRAM_ALLOWED_USER_IDS не задан или пуст")
        return []
    res = []
    for val in values:
        try:
            res.append(int(val))
        except ValueError as exc:
            raise ConfigError("Каждый ID в TELEGRAM_ALLOWED_USER_IDS должен быть целым числом") from exc
    return res
