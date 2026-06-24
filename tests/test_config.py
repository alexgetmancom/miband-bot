# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alexey

from pathlib import Path

import pytest

from miband_tracker.config import ConfigError, Settings, parse_user_ids


def test_parse_user_ids_accepts_multiple_values() -> None:
    assert parse_user_ids("1,2", required=True) == [1, 2]
    assert parse_user_ids("1", required=True) == [1]


def test_parse_user_ids_rejects_invalid_values() -> None:
    with pytest.raises(ConfigError):
        parse_user_ids("1,invalid", required=True)


def test_settings_user_paths_prefer_existing_user_files(tmp_path: Path) -> None:
    user_id = 123
    (tmp_path / f"miband_{user_id}.db").write_text("", encoding="utf-8")
    (tmp_path / f"status_{user_id}.json").write_text("{}", encoding="utf-8")
    (tmp_path / f"token_{user_id}.json").write_text("{}", encoding="utf-8")

    settings = Settings(
        data_dir=tmp_path,
        db_path=tmp_path / "miband.db",
        status_path=tmp_path / "status.json",
        bot_state_db_path=tmp_path / "fitness_bot_state.db",
        telegram_bot_token="token",
        telegram_allowed_user_ids=[user_id],
        sync_interval=900,
        query_duration=2,
        enable_fds_sleep_details=True,
    )

    assert settings.telegram_allowed_user_id == user_id
    assert settings.user_db_path() == tmp_path / f"miband_{user_id}.db"
    assert settings.user_status_path() == tmp_path / f"status_{user_id}.json"
    assert settings.token_path() == tmp_path / f"token_{user_id}.json"


def test_settings_falls_back_to_legacy_db_and_status(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        db_path=tmp_path / "miband.db",
        status_path=tmp_path / "status.json",
        bot_state_db_path=tmp_path / "fitness_bot_state.db",
        telegram_bot_token="token",
        telegram_allowed_user_ids=[123],
        sync_interval=900,
        query_duration=2,
        enable_fds_sleep_details=True,
    )

    assert settings.user_db_path() == tmp_path / "miband.db"
    assert settings.user_status_path() == tmp_path / "status.json"
    assert settings.canonical_user_db_path() == tmp_path / "miband_123.db"


def test_settings_from_env_rejects_invalid_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TELEGRAM_ALLOWED_USER_IDS", "123")
    monkeypatch.setenv("SYNC_INTERVAL", "soon")

    with pytest.raises(ConfigError, match="SYNC_INTERVAL"):
        Settings.from_env()


def test_settings_from_env_rejects_zero_query_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TELEGRAM_ALLOWED_USER_IDS", "123")
    monkeypatch.setenv("QUERY_DURATION", "0")

    with pytest.raises(ConfigError, match="QUERY_DURATION"):
        Settings.from_env()
