# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alexey

import asyncio
import json
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

import miband_tracker.bot.app as bot_app
from miband_tracker import storage
from miband_tracker.config import Settings
from miband_tracker.sync import SyncResult


class FakeUser:
    id = 123


class FakeUpdate:
    effective_user = FakeUser()
    message = object()
    callback_query = None


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        db_path=tmp_path / "miband.db",
        status_path=tmp_path / "status.json",
        bot_state_db_path=tmp_path / "fitness_bot_state.db",
        telegram_bot_token="token",
        telegram_allowed_user_id=123,
        sync_interval=900,
        query_duration=2,
        enable_fds_sleep_details=True,
    )


def test_service_menu_does_not_expose_invites_or_second_user(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)

    monkeypatch.setattr(bot_app, "SETTINGS", settings)
    monkeypatch.setattr(bot_app, "ALLOWED_USER_ID", 123)
    monkeypatch.setattr(bot_app, "DB_PATH", str(settings.canonical_user_db_path()))

    keyboard = bot_app.more_keyboard()
    labels = [
        button.text
        for row in keyboard.inline_keyboard
        for button in row
    ]
    rendered = "\n".join([*labels, bot_app.more_text()])

    assert "Принять приглашения" not in rendered
    assert "Приглашения" not in rendered
    assert "втор" not in rendered.lower()


@pytest.mark.asyncio
async def test_cmd_start_without_token_shows_onboarding(monkeypatch: pytest.MonkeyPatch) -> None:
    update = FakeUpdate()
    context = object()
    show_onboarding = AsyncMock()
    show_main_menu = AsyncMock()

    monkeypatch.setattr(bot_app, "is_allowed", lambda _: True)
    monkeypatch.setattr(bot_app, "has_xiaomi_token", lambda: False)
    monkeypatch.setattr(bot_app, "safe_delete", AsyncMock())
    monkeypatch.setattr(bot_app, "show_onboarding", show_onboarding)
    monkeypatch.setattr(bot_app, "show_main_menu", show_main_menu)

    await bot_app.cmd_start(update, context)

    show_onboarding.assert_awaited_once_with(update, context, force_new=True)
    show_main_menu.assert_not_awaited()


@pytest.mark.asyncio
async def test_start_xiaomi_login_saves_token_syncs_and_opens_menu(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    update = FakeUpdate()
    context = object()
    token_path = tmp_path / "token_123.json"

    class FakeToken:
        def model_dump(self):
            return {
                "user_id": "456",
                "c_user_id": "",
                "service_token": "service",
                "ssecurity": "sec",
                "pass_token": "pass",
                "device_id": "device",
            }

    class FakeAuth:
        async def login_qr(self, *, qr_callback, max_wait):
            await qr_callback("https://example.test/qr.png", "https://example.test/login")
            return FakeToken()

        async def close(self):
            return None

    settings = _settings(tmp_path)
    run_sync = AsyncMock(return_value=SyncResult(True, user_id=123))
    show_main_menu = AsyncMock()

    monkeypatch.setattr(bot_app, "SETTINGS", settings)
    monkeypatch.setattr(bot_app, "ALLOWED_USER_ID", 123)
    monkeypatch.setattr(bot_app, "AUTH_LOCK", asyncio.Lock())
    monkeypatch.setattr(bot_app, "SYNC_LOCK", asyncio.Lock())
    monkeypatch.setattr(bot_app, "XiaomiAuth", FakeAuth)
    monkeypatch.setattr(bot_app, "update_menu", AsyncMock())
    monkeypatch.setattr(bot_app, "run_sync", run_sync)
    monkeypatch.setattr(bot_app, "show_main_menu", show_main_menu)

    await bot_app.start_xiaomi_login(update, context)

    data = json.loads(token_path.read_text(encoding="utf-8"))
    assert data["user_id"] == "456"
    assert data["service_token"] == "service"
    run_sync.assert_awaited_once()
    call_args = run_sync.await_args[0]
    assert call_args[0] == 123
    assert call_args[1].query_duration == 30
    show_main_menu.assert_awaited_once_with(update, context)


def test_main_menu_renders_extended_metrics(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(tmp_path)
    db_path = settings.canonical_user_db_path()
    storage.init_health_db(db_path)
    with storage.sqlite_conn(db_path, row_factory=False) as conn:
        conn.execute(
            "INSERT INTO steps_daily (date, total_steps, calories, distance_m, last_sync) VALUES (?, ?, ?, ?, ?)",
            ("2026-05-26", 451, 22.0, 296.0, 1),
        )
        conn.execute("INSERT INTO heart_rate (timestamp, value) VALUES (?, ?)", (1779768600, 73))
        conn.execute("INSERT INTO blood_oxygen (timestamp, spo2, type) VALUES (?, ?, ?)", (1779768900, 99.0, "latest"))
        conn.execute("INSERT INTO stress (timestamp, value) VALUES (?, ?)", (1779757800, 29))
        conn.execute(
            """
            INSERT INTO calories_daily
                (date, total_cal, active_cal, valid_stand_hours, intensity_minutes, last_sync)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("2026-05-26", 55.0, None, 1, 6, 1),
        )
        conn.commit()

    monkeypatch.setattr(bot_app, "SETTINGS", settings)
    monkeypatch.setattr(bot_app, "ALLOWED_USER_ID", 123)
    monkeypatch.setattr(bot_app, "DB_PATH", str(db_path))

    rendered = bot_app.main_menu_text()

    assert "451" in rendered
    assert "99%" in rendered
    assert "🧘" in rendered
    assert "22</b> ккал" in rendered


def test_workouts_text_renders_recent_workout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(tmp_path)
    db_path = settings.canonical_user_db_path()
    storage.init_health_db(db_path)
    with storage.sqlite_conn(db_path, row_factory=False) as conn:
        conn.execute(
            """
            INSERT INTO workouts
                (workout_id, sport_type, start_time, end_time, duration_sec,
                 calories, avg_hr, max_hr, min_hr, watermark, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("w1", "free_training", 1779752903, 1779753050, 142, 7.0, 95, 152, 80, 1, "{}"),
        )
        conn.commit()

    monkeypatch.setattr(bot_app, "SETTINGS", settings)
    monkeypatch.setattr(bot_app, "ALLOWED_USER_ID", 123)
    monkeypatch.setattr(bot_app, "DB_PATH", str(db_path))

    rendered = bot_app.workouts_text()

    assert "Тренировки" in rendered
    assert "Свободная" in rendered
    assert "95 bpm" in rendered


def test_sleep_text_has_no_fds_hint_or_calendar_button(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(tmp_path)
    db_path = settings.canonical_user_db_path()
    storage.init_health_db(db_path)
    with storage.sqlite_conn(db_path, row_factory=False) as conn:
        conn.execute(
            """
            INSERT INTO sleep_daily
                (date, light_sleep_min, deep_sleep_min, start_time, end_time,
                 rem_sleep_min, awake_min, total_duration_min, sleep_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("2026-05-26", 137, 123, 1779744540, 1779770460, 136, 0, 396, 64),
        )
        conn.commit()

    monkeypatch.setattr(bot_app, "SETTINGS", settings)
    monkeypatch.setattr(bot_app, "ALLOWED_USER_ID", 123)
    monkeypatch.setattr(bot_app, "DB_PATH", str(db_path))

    rendered = bot_app.latest_sleep_text()
    keyboard_labels = [
        button.text
        for row in bot_app.back_keyboard().inline_keyboard
        for button in row
    ]

    assert "Детали подтягиваются" not in rendered
    assert "FDS" not in rendered
    assert "Календарь" not in keyboard_labels


def test_trends_screen_labels_and_keyboard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _settings(tmp_path)

    monkeypatch.setattr(bot_app, "SETTINGS", settings)
    monkeypatch.setattr(bot_app, "ALLOWED_USER_ID", 123)
    monkeypatch.setattr(bot_app, "DB_PATH", str(settings.canonical_user_db_path()))

    rendered = bot_app.period_text(3650)
    keyboard = bot_app.trends_keyboard(3650)
    labels = [
        button.text
        for row in keyboard.inline_keyboard
        for button in row
    ]

    assert "Тренды" in rendered
    assert "Все время" in rendered
    assert not any("Аналитика" in label for label in labels)
    assert not any("Детали сна" in label for label in labels)
    assert any("Все время" in label for label in labels)


@pytest.mark.asyncio
async def test_auto_refresh_updates_saved_menu_after_status_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    storage.init_health_db(settings.canonical_user_db_path())
    storage.init_state_db(settings)
    storage.set_user_menu_msg_id(settings, 123, 99)
    settings.canonical_user_status_path(123).write_text("{}", encoding="utf-8")

    class FakeBot:
        edit_message_text = AsyncMock()

    class FakeApp:
        bot = FakeBot()

    monkeypatch.setattr(bot_app, "SETTINGS", settings)
    monkeypatch.setattr(bot_app, "ALLOWED_USER_ID", 123)
    monkeypatch.setattr(bot_app, "DB_PATH", str(settings.canonical_user_db_path()))
    monkeypatch.setattr(bot_app, "AUTO_MENU_REFRESH_INTERVAL", 0.01)

    task = asyncio.create_task(bot_app.auto_refresh_main_menu_loop(FakeApp()))
    await asyncio.sleep(0.02)
    now = time.time() + 1
    path = settings.canonical_user_status_path(123)
    path.write_text('{"last_sync": 1}', encoding="utf-8")
    os.utime(path, (now, now))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    FakeApp.bot.edit_message_text.assert_awaited()
