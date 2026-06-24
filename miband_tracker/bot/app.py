#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alexey

from __future__ import annotations

import asyncio
import io
import logging
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta
from functools import wraps
from pathlib import Path

from mi_fitness.auth import XiaomiAuth
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update
from telegram.error import RetryAfter, TelegramError
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from miband_tracker import storage
from miband_tracker.bot.formatting import (
    LOCAL_TZ,
    RU_MONTHS,
    day_bounds,
    esc,
    format_epoch,
    format_minutes,
    format_relative_time,
    make_sleep_bar,
    make_sparkline,
    parse_day,
    relative_day_label,
    sleep_total,
    workout_type_label,
)
from miband_tracker.config import ConfigError, Settings
from miband_tracker.secure_files import save_auth_token
from miband_tracker.sync import run_sync

# ---------------------------------------------------------------------------
# Logging — console shows only WARNING+ so users don't see debug spam.
# The mi-fitness vendored library uses loguru with Chinese debug messages;
# we suppress those to ERROR as well.
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)
logging.getLogger("telegram.ext").setLevel(logging.WARNING)
logger = logging.getLogger("fitness-bot")

try:
    from loguru import logger as _loguru_logger
    _loguru_logger.remove()  # Remove loguru's default stderr handler
    _loguru_logger.add(sys.stderr, level="ERROR", format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}")
except Exception:
    pass

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
import contextvars

SETTINGS = Settings.from_env()
BOT_TOKEN = SETTINGS.telegram_bot_token
ALLOWED_USER_ID = SETTINGS.telegram_allowed_user_id
DB_PATH = str(SETTINGS.db_path)
SYNC_LOCK = asyncio.Lock()
AUTH_LOCK = asyncio.Lock()
AUTO_MENU_REFRESH_INTERVAL = max(5, int(os.getenv("AUTO_MENU_REFRESH_INTERVAL", "30")))

current_user_id_var = contextvars.ContextVar("current_user_id", default=None)

STEP_GOAL = 10_000  # можно вынести в env при желании


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def get_current_user_id() -> int | None:
    uid = current_user_id_var.get()
    if uid is not None:
        return uid
    allowed_ids = SETTINGS.telegram_allowed_user_ids
    if allowed_ids:
        return allowed_ids[0]
    return None


def is_allowed(update: Update) -> bool:
    global SETTINGS, ALLOWED_USER_ID
    uid = update.effective_user.id if update.effective_user else None
    if uid is None:
        return False
    
    allowed_ids = SETTINGS.telegram_allowed_user_ids
    if not allowed_ids:
        ALLOWED_USER_ID = uid
        try:
            allowed_user_file = SETTINGS.data_dir / "allowed_user.id"
            SETTINGS.data_dir.mkdir(parents=True, exist_ok=True)
            allowed_user_file.write_text(str(uid), encoding="utf-8")
            logger.info("🎉 Бот успешно привязан к первому пользователю (ID: %s)!", uid)
            SETTINGS = Settings.from_env()
            allowed_ids = SETTINGS.telegram_allowed_user_ids
        except Exception as e:
            logger.error("Не удалось сохранить ID владельца в файл: %s", e)
        return True
    return uid in allowed_ids


def with_user_context(func):
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE, *args, **kwargs):
        uid = update.effective_user.id if update.effective_user else None
        token = current_user_id_var.set(uid)
        try:
            return await func(update, context, *args, **kwargs)
        finally:
            current_user_id_var.reset(token)
    return wrapper


def get_user_db_path() -> str:
    uid = get_current_user_id()
    if uid is None:
        return DB_PATH
    return str(SETTINGS.user_db_path(uid))


def get_user_status_path() -> str:
    uid = get_current_user_id()
    if uid is None:
        return str(SETTINGS.status_path)
    return str(SETTINGS.user_status_path(uid))


def get_xiaomi_token_path() -> Path | None:
    uid = get_current_user_id()
    if uid is None:
        return None
    try:
        return SETTINGS.token_path(uid)
    except ConfigError:
        return None


def has_xiaomi_token() -> bool:
    token_path = get_xiaomi_token_path()
    return bool(token_path and token_path.exists())


def get_sleep_sparkline(table: str, field: str, start_epoch: int, end_epoch: int) -> str:
    rows = fetch_all(
        f"SELECT {field} FROM {table} WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC",
        (start_epoch, end_epoch),
    )
    if not rows:
        return ""
    values = [row[field] for row in rows]
    if len(values) > 20:
        step = len(values) / 20
        values = [values[int(i * step)] for i in range(20)]
    return make_sparkline(values)


# ---------------------------------------------------------------------------
# Daily tip engine
# ---------------------------------------------------------------------------
def daily_tip(steps: sqlite3.Row | None, sleep: sqlite3.Row | None, hr: sqlite3.Row | None) -> str:
    """Генерирует один персональный инсайт на основе последних данных."""
    tips = []
    is_en = os.getenv("BOT_LANG") == "en"

    if steps:
        s = int(steps["total_steps"] or 0)
        if s < 5000:
            if is_en:
                tips.append("💡 Very few steps today. A 20-minute walk will add ~2 000 steps and boost your mood.")
            else:
                tips.append("💡 Сегодня совсем мало шагов. Прогулка в 20 минут добавит ~2 000 шагов и заметно поднимет настроение.")
        elif s >= STEP_GOAL:
            if is_en:
                tips.append("💡 Daily step goal reached — excellent job!")
            else:
                tips.append("💡 Дневная норма шагов выполнена — отличный результат!")
        elif s >= 7000:
            if is_en:
                tips.append(f"💡 {STEP_GOAL - s:,} steps left to reach your goal of {STEP_GOAL:,} — almost there!".replace(",", " "))
            else:
                tips.append(f"💡 До цели {STEP_GOAL:,} шагов осталось {STEP_GOAL - s:,} — почти дошли!".replace(",", " "))

    if sleep:
        total = sleep_total(sleep)
        deep = int(sleep["deep_sleep_min"] or 0)
        if total < 300:
            if is_en:
                tips.append("💡 Sleep was under 5 hours — that's too short. Try to go to bed earlier tonight.")
            else:
                tips.append("💡 Ночной сон меньше 5 часов — это мало. Постарайтесь лечь пораньше сегодня.")
        elif total < 360:
            if is_en:
                tips.append("💡 Sleep was under 6 hours. Try to go to bed earlier tonight.")
            else:
                tips.append("💡 Ночной сон меньше 6 часов. Постарайтесь лечь пораньше сегодня.")
        elif deep < 30:
            if is_en:
                tips.append("💡 Very little deep sleep. Try airing out the room and avoiding screens for an hour before bed.")
            else:
                tips.append("💡 Глубокого сна было совсем мало. Попробуйте проветрить комнату и ограничить экраны за час до сна.")

    if hr:
        bpm = int(hr["value"])
        if bpm > 90:
            if is_en:
                tips.append("💡 Resting heart rate is elevated — the body might be tired or stressed. Keep an eye on how you feel.")
            else:
                tips.append("💡 Пульс в покое выше нормы — возможно, организм устал или есть стресс. Следите за самочувствием.")
        elif bpm < 50:
            if is_en:
                tips.append("💡 Very low heart rate — if you are an athlete, it's fine. Otherwise, pay close attention.")
            else:
                tips.append("💡 Очень низкий пульс — если это спортивная норма, всё хорошо. Если нет — стоит обратить внимание.")

    if not tips:
        if is_en:
            tips.append("💡 Enough data, keep up the good work!")
        else:
            tips.append("💡 Данных достаточно, продолжайте в том же духе!")

    return tips[0]  # показываем один самый актуальный совет


# ---------------------------------------------------------------------------
# DB: health
# ---------------------------------------------------------------------------
def health_db_exists() -> bool:
    return storage.health_db_exists(SETTINGS, get_current_user_id())


def health_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(get_user_db_path())
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.row_factory = sqlite3.Row
    return conn


def fetch_one(query: str, params: tuple = ()) -> sqlite3.Row | None:
    return storage.fetch_one(SETTINGS, query, params, get_current_user_id())


def fetch_all(query: str, params: tuple = ()) -> list[sqlite3.Row]:
    return storage.fetch_all(SETTINGS, query, params, get_current_user_id())


# ---------------------------------------------------------------------------
# DB: bot state
# ---------------------------------------------------------------------------
def init_state_db() -> None:
    storage.init_state_db(SETTINGS)


def get_user_menu_msg_id(user_id: int) -> int | None:
    try:
        return storage.get_user_menu_msg_id(SETTINGS, user_id)
    except Exception as e:
        logger.warning("Failed to read menu message id for %s: %s", user_id, e)
        return None


def set_user_menu_msg_id(user_id: int, msg_id: int) -> None:
    try:
        storage.set_user_menu_msg_id(SETTINGS, user_id, msg_id)
    except Exception as e:
        logger.warning("Failed to save menu message id for %s: %s", user_id, e)


# ---------------------------------------------------------------------------
# Telegram: safe edit with exponential backoff
# ---------------------------------------------------------------------------
async def safe_delete(message: Message | None) -> None:
    if not message:
        return
    try:
        await message.delete()
    except Exception as e:
        logger.debug("Failed to delete message: %s", e)


async def send_or_update_menu(
    bot,
    user_id: int,
    text: str,
    reply_markup: InlineKeyboardMarkup | None = None,
    force_new: bool = False,
) -> None:
    chat_id = user_id
    msg_id = get_user_menu_msg_id(user_id)

    if msg_id and not force_new:
        for attempt in range(3):
            try:
                await bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=msg_id,
                    text=text,
                    parse_mode="HTML",
                    reply_markup=reply_markup,
                    disable_web_page_preview=True,
                )
                return
            except RetryAfter as e:
                wait = e.retry_after + attempt
                logger.warning("Flood control: waiting %ss (attempt %d)", wait, attempt + 1)
                await asyncio.sleep(wait)
            except TelegramError as e:
                msg = str(e)
                if "Message is not modified" in msg:
                    return
                if "Message to edit not found" in msg or "message can't be edited" in msg.lower():
                    break  # сообщение пропало — создаём новое
                logger.warning("Edit failed (attempt %d): %s", attempt + 1, e)
                break

    # Старое сообщение устарело или не найдено — удаляем и создаём новое
    if msg_id:
        try:
            await bot.delete_message(chat_id=chat_id, message_id=msg_id)
        except Exception as e:
            logger.debug("Failed to delete old menu message %s: %s", msg_id, e)

    new_msg = await bot.send_message(
        chat_id=chat_id,
        text=text,
        parse_mode="HTML",
        reply_markup=reply_markup,
        disable_web_page_preview=True,
    )
    set_user_menu_msg_id(user_id, new_msg.message_id)


async def update_menu(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    reply_markup: InlineKeyboardMarkup | None = None,
    force_new: bool = False,
) -> None:
    if not update.effective_user:
        return
    user_id = update.effective_user.id
    if update.callback_query and update.callback_query.message:
        set_user_menu_msg_id(user_id, update.callback_query.message.message_id)
    await send_or_update_menu(context.bot, user_id, text, reply_markup, force_new)


async def auto_refresh_main_menu_loop(app: Application) -> None:
    """Refresh the pinned main menu for all allowed users after the sync daemon writes their status file."""
    last_seen_mtimes: dict[int, float] = {}
    while True:
        try:
            allowed_ids = SETTINGS.telegram_allowed_user_ids
            for uid in allowed_ids:
                status_path = SETTINGS.user_status_path(uid)
                if status_path.exists():
                    current_mtime = status_path.stat().st_mtime
                    last_seen_mtime = last_seen_mtimes.get(uid)
                    if last_seen_mtime is None:
                        last_seen_mtimes[uid] = current_mtime
                    elif current_mtime > last_seen_mtime:
                        last_seen_mtimes[uid] = current_mtime
                        if get_user_menu_msg_id(uid):
                            token = current_user_id_var.set(uid)
                            try:
                                await send_or_update_menu(
                                    app.bot,
                                    uid,
                                    main_menu_text(),
                                    main_keyboard(),
                                )
                                logger.info("Auto-refreshed main menu for user %s", uid)
                            finally:
                                current_user_id_var.reset(token)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Auto menu refresh failed: %s", exc)

        await asyncio.sleep(AUTO_MENU_REFRESH_INTERVAL)


def format_weekday(date_str: str) -> str:
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        wd = dt.weekday()
        wd_ru = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
        return wd_ru[wd]
    except Exception:
        return ""


def average_bedtime(sleep_rows) -> float | None:
    offsets = []
    for r in sleep_rows:
        if not r or "start_time" not in r.keys() or r["start_time"] is None:
            continue
        try:
            dt = datetime.fromtimestamp(r["start_time"], LOCAL_TZ)
            minutes = dt.hour * 60 + dt.minute
            if minutes > 720:
                minutes -= 1440
            offsets.append(minutes)
        except Exception:
            pass
    if not offsets:
        return None
    return sum(offsets) / len(offsets)


def format_bedtime(avg_offset: float | None) -> str:
    if avg_offset is None:
        return "N/A"
    minutes = int(round(avg_offset))
    if minutes < 0:
        minutes += 1440
    hour = (minutes // 60) % 24
    minute = minutes % 60
    return f"{hour:02d}:{minute:02d}"


def weekly_summary_text() -> str:
    today = datetime.now(LOCAL_TZ).date()
    start_curr = today - timedelta(days=6)
    end_curr = today
    
    start_prev = today - timedelta(days=13)
    end_prev = today - timedelta(days=7)
    
    # 1. Запросы текущей недели
    steps_curr = fetch_all(
        "SELECT date, total_steps FROM steps_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC",
        (start_curr.isoformat(), end_curr.isoformat()),
    )
    sleep_curr = fetch_all(
        "SELECT date, total_duration_min, start_time FROM sleep_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC",
        (start_curr.isoformat(), end_curr.isoformat()),
    )
    
    # 2. Запросы предыдущей недели
    steps_prev = fetch_all(
        "SELECT date, total_steps FROM steps_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC",
        (start_prev.isoformat(), end_prev.isoformat()),
    )
    sleep_prev = fetch_all(
        "SELECT date, total_duration_min, start_time FROM sleep_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC",
        (start_prev.isoformat(), end_prev.isoformat()),
    )
    
    # 3. Расчет текущих показателей
    steps_list_curr = [int(r["total_steps"]) for r in steps_curr if r["total_steps"] is not None]
    avg_steps_curr = round(sum(steps_list_curr) / len(steps_list_curr)) if steps_list_curr else 0
    
    sleep_list_curr = [int(r["total_duration_min"]) for r in sleep_curr if r["total_duration_min"] is not None]
    avg_sleep_curr = round(sum(sleep_list_curr) / len(sleep_list_curr)) if sleep_list_curr else 0
    avg_bedtime_curr = average_bedtime(sleep_curr)
    
    # 4. Расчет предыдущих показателей
    steps_list_prev = [int(r["total_steps"]) for r in steps_prev if r["total_steps"] is not None]
    avg_steps_prev = round(sum(steps_list_prev) / len(steps_list_prev)) if steps_list_prev else 0
    
    sleep_list_prev = [int(r["total_duration_min"]) for r in sleep_prev if r["total_duration_min"] is not None]
    avg_sleep_prev = round(sum(sleep_list_prev) / len(sleep_list_prev)) if sleep_list_prev else 0
    avg_bedtime_prev = average_bedtime(sleep_prev)
    
    # 5. Разницы
    diff_steps_str = ""
    if avg_steps_prev > 0:
        diff_steps = avg_steps_curr - avg_steps_prev
        diff_steps_str = f" ({'+' if diff_steps >= 0 else ''}{diff_steps} {'📈' if diff_steps >= 0 else '📉'})"
        
    diff_sleep_str = ""
    if avg_sleep_prev > 0:
        diff_sleep = avg_sleep_curr - avg_sleep_prev
        diff_sleep_str = f" ({'+' if diff_sleep >= 0 else ''}{diff_sleep} мин {'📈' if diff_sleep >= 0 else '📉'})"
        
    diff_bedtime_str = ""
    if avg_bedtime_prev is not None and avg_bedtime_curr is not None:
        diff_bedtime = avg_bedtime_curr - avg_bedtime_prev
        emoji = "📈" if diff_bedtime <= 0 else "📉"
        sign = "-" if diff_bedtime <= 0 else "+"
        diff_bedtime_str = f" ({sign}{abs(round(diff_bedtime))} мин {emoji})"
        
    # 6. Рекорды
    record_steps_row = max(steps_curr, key=lambda r: r["total_steps"] or 0, default=None)
    record_steps_str = "N/A"
    if record_steps_row and record_steps_row["total_steps"] is not None:
        wd = format_weekday(record_steps_row["date"])
        record_steps_str = f"{record_steps_row['total_steps']} ({wd})"
        
    record_sleep_row = max(sleep_curr, key=lambda r: r["total_duration_min"] or 0, default=None)
    record_sleep_str = "N/A"
    if record_sleep_row and record_sleep_row["total_duration_min"] is not None:
        wd = format_weekday(record_sleep_row["date"])
        dur = record_sleep_row["total_duration_min"]
        record_sleep_str = f"{dur // 60} ч {dur % 60} мин ({wd})"
        
    # 7. Форматирование диапазона дат
    start_format = start_curr.strftime("%d")
    end_format = end_curr.strftime("%d")
    if start_curr.month == end_curr.month:
        month_name = RU_MONTHS[start_curr.month - 1]
        date_range = f"{start_format}–{end_format} {month_name}"
    else:
        start_month = RU_MONTHS[start_curr.month - 1]
        end_month = RU_MONTHS[end_curr.month - 1]
        date_range = f"{start_format} {start_month} — {end_format} {end_month}"
        
    # 8. Сон часы и минуты
    avg_sleep_h = avg_sleep_curr // 60
    avg_sleep_m = avg_sleep_curr % 60
    sleep_time_str = f"{avg_sleep_h} ч {avg_sleep_m} мин" if avg_sleep_curr > 0 else "N/A"
    
    # 9. Сборка текста
    lines = [
        f"📊 <b>Итоги недели: {date_range}</b>\n",
        f"🚶 Шаги: {avg_steps_curr} в день{diff_steps_str}",
        f"😴 Сон: {sleep_time_str}{diff_sleep_str}",
        f"⏰ Засыпание: {format_bedtime(avg_bedtime_curr)}{diff_bedtime_str}\n",
        f"🏆 Рекорды: • Шаги: {record_steps_str} • Сон: {record_sleep_str}"
    ]
    return "\n".join(lines)


async def weekly_push_loop(app: Application) -> None:
    """Send weekly summary push notification every Sunday at 21:00."""
    last_sent_date: str | None = None
    while True:
        try:
            now = datetime.now(LOCAL_TZ)
            if now.weekday() == 6 and now.hour == 21 and now.minute == 0:
                current_date = now.strftime("%Y-%m-%d")
                if last_sent_date != current_date:
                    last_sent_date = current_date
                    allowed_ids = SETTINGS.telegram_allowed_user_ids
                    logger.info("Starting weekly push for users: %s", allowed_ids)
                    for uid in allowed_ids:
                        token = current_user_id_var.set(uid)
                        try:
                            if health_db_exists():
                                push_text = weekly_summary_text()
                                await app.bot.send_message(
                                    chat_id=uid,
                                    text=push_text,
                                    parse_mode="HTML",
                                )
                                logger.info("Weekly push sent to user %s", uid)
                        except Exception as e:
                            logger.error("Failed to send weekly push to user %s: %s", uid, e)
                        finally:
                            current_user_id_var.reset(token)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Weekly push loop encountered error: %s", exc)

        await asyncio.sleep(30)


async def start_background_tasks(app: Application) -> None:
    app.bot_data["auto_refresh_main_menu_task"] = asyncio.create_task(
        auto_refresh_main_menu_loop(app),
        name="auto-refresh-main-menu",
    )
    app.bot_data["weekly_push_task"] = asyncio.create_task(
        weekly_push_loop(app),
        name="weekly-push",
    )


async def stop_background_tasks(app: Application) -> None:
    task = app.bot_data.get("auto_refresh_main_menu_task")
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    task_push = app.bot_data.get("weekly_push_task")
    if task_push:
        task_push.cancel()
        try:
            await task_push
        except asyncio.CancelledError:
            pass


# ---------------------------------------------------------------------------
# Data queries
# ---------------------------------------------------------------------------
def read_status_file() -> dict:
    return storage.read_status_file(SETTINGS, get_current_user_id())


def latest_steps() -> sqlite3.Row | None:
    return fetch_one(
        """
        SELECT date, total_steps, calories, distance_m, last_sync
        FROM steps_daily
        ORDER BY date DESC
        LIMIT 1
        """
    )


def latest_sleep() -> sqlite3.Row | None:
    return fetch_one(
        """
        SELECT date, light_sleep_min, deep_sleep_min, start_time, end_time,
               COALESCE(rem_sleep_min, 0) AS rem_sleep_min,
               COALESCE(awake_min, 0) AS awake_min,
               COALESCE(total_duration_min, 0) AS total_duration_min,
               COALESCE(sleep_score, 0) AS sleep_score
        FROM sleep_daily
        ORDER BY date DESC
        LIMIT 1
        """
    )


def latest_hr() -> sqlite3.Row | None:
    return fetch_one("SELECT timestamp, value FROM heart_rate ORDER BY timestamp DESC LIMIT 1")


def latest_spo2() -> sqlite3.Row | None:
    return fetch_one(
        "SELECT timestamp, spo2, type FROM blood_oxygen ORDER BY timestamp DESC LIMIT 1"
    )


def latest_stress() -> sqlite3.Row | None:
    return fetch_one("SELECT timestamp, value FROM stress ORDER BY timestamp DESC LIMIT 1")


def latest_weight() -> sqlite3.Row | None:
    return fetch_one("SELECT timestamp, weight_kg FROM weight ORDER BY timestamp DESC LIMIT 1")


def latest_calories() -> sqlite3.Row | None:
    return fetch_one(
        """
        SELECT date, total_cal, valid_stand_hours, intensity_minutes
        FROM calories_daily
        ORDER BY date DESC
        LIMIT 1
        """
    )


def recent_workouts(limit: int = 5) -> list[sqlite3.Row]:
    return fetch_all(
        """
        SELECT workout_id, sport_type, start_time, end_time,
               duration_sec, calories, avg_hr, max_hr, min_hr
        FROM workouts
        ORDER BY start_time DESC
        LIMIT ?
        """,
        (limit,),
    )


def resting_hr(start_epoch: int, end_epoch: int) -> int | None:
    """Пульс покоя = минимальный за окно сна (игнорируем нули и аномалии < 30)."""
    row = fetch_one(
        """
        SELECT MIN(value) AS min_hr
        FROM heart_rate
        WHERE timestamp >= ? AND timestamp < ? AND value > 30
        """,
        (start_epoch, end_epoch),
    )
    if row and row["min_hr"]:
        return int(row["min_hr"])
    return None


def metric_stats(table: str, field: str, start_epoch: int, end_epoch: int) -> sqlite3.Row | None:
    return fetch_one(
        f"""
        SELECT COUNT(*) AS count,
               ROUND(AVG({field}), 1) AS avg_value,
               MIN({field}) AS min_value,
               MAX({field}) AS max_value
        FROM {table}
        WHERE timestamp >= ? AND timestamp < ?
        """,
        (start_epoch, end_epoch),
    )


def sleep_window_stats(sleep: sqlite3.Row | None) -> tuple[sqlite3.Row | None, sqlite3.Row | None]:
    if not sleep or not sleep["start_time"] or not sleep["end_time"]:
        return None, None
    hr = metric_stats("heart_rate", "value", int(sleep["start_time"]), int(sleep["end_time"]))
    spo2 = metric_stats(
        "blood_oxygen", "spo2", int(sleep["start_time"]), int(sleep["end_time"])
    )
    return hr, spo2


def day_summary(day_str: str) -> dict:
    day_value = parse_day(day_str)
    start_epoch, end_epoch = day_bounds(day_value)
    steps = fetch_one(
        """
        SELECT date, total_steps, calories, distance_m, last_sync
        FROM steps_daily
        WHERE date = ?
        """,
        (day_str,),
    )
    sleep = fetch_one(
        """
        SELECT date, light_sleep_min, deep_sleep_min, start_time, end_time,
               COALESCE(rem_sleep_min, 0) AS rem_sleep_min,
               COALESCE(awake_min, 0) AS awake_min,
               COALESCE(total_duration_min, 0) AS total_duration_min,
               COALESCE(sleep_score, 0) AS sleep_score
        FROM sleep_daily
        WHERE date = ?
        """,
        (day_str,),
    )
    hr = metric_stats("heart_rate", "value", start_epoch, end_epoch)
    spo2 = metric_stats("blood_oxygen", "spo2", start_epoch, end_epoch)
    stress = metric_stats("stress", "value", start_epoch, end_epoch)
    calories = fetch_one(
        """
        SELECT total_cal, active_cal, valid_stand_hours, intensity_minutes
        FROM calories_daily
        WHERE date = ?
        """,
        (day_str,),
    )
    weight = fetch_one(
        """
        SELECT weight_kg, bmi, body_fat_pct
        FROM weight
        WHERE timestamp <= ?
        ORDER BY timestamp DESC
        LIMIT 1
        """,
        (end_epoch,),
    )
    workouts = fetch_all(
        """
        SELECT workout_id, sport_type, start_time, end_time, duration_sec, calories, avg_hr, max_hr, min_hr
        FROM workouts
        WHERE start_time >= ? AND start_time < ?
        ORDER BY start_time ASC
        """,
        (start_epoch, end_epoch),
    )
    return {
        "date": day_str,
        "steps": steps,
        "sleep": sleep,
        "hr": hr,
        "spo2": spo2,
        "stress": stress,
        "calories": calories,
        "weight": weight,
        "workouts": workouts,
    }


def available_days(limit: int = 14) -> list[str]:
    rows = fetch_all(
        """
        SELECT date FROM (
            SELECT date FROM steps_daily
            UNION
            SELECT date FROM sleep_daily
        )
        ORDER BY date DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [row["date"] for row in rows]


def period_bounds(days: int) -> tuple[date, date, int, int]:
    end_day = datetime.now(LOCAL_TZ).date()
    start_day = end_day - timedelta(days=days - 1)
    start_epoch, _ = day_bounds(start_day)
    _, end_epoch = day_bounds(end_day)
    return start_day, end_day, start_epoch, end_epoch


def period_summary(days: int) -> dict:
    start_day, end_day, start_epoch, end_epoch = period_bounds(days)
    steps = fetch_all(
        """
        SELECT date, total_steps, calories, distance_m
        FROM steps_daily
        WHERE date BETWEEN ? AND ?
        ORDER BY date DESC
        """,
        (start_day.isoformat(), end_day.isoformat()),
    )
    sleep = fetch_all(
        """
        SELECT date, light_sleep_min, deep_sleep_min, start_time, end_time,
               COALESCE(rem_sleep_min, 0) AS rem_sleep_min,
               COALESCE(awake_min, 0) AS awake_min,
               COALESCE(total_duration_min, 0) AS total_duration_min,
               COALESCE(sleep_score, 0) AS sleep_score
        FROM sleep_daily
        WHERE date BETWEEN ? AND ?
        ORDER BY date DESC
        """,
        (start_day.isoformat(), end_day.isoformat()),
    )
    hr = metric_stats("heart_rate", "value", start_epoch, end_epoch)
    spo2 = metric_stats("blood_oxygen", "spo2", start_epoch, end_epoch)
    stress = metric_stats("stress", "value", start_epoch, end_epoch)

    calories_rows = fetch_all(
        """
        SELECT date, total_cal, active_cal, valid_stand_hours, intensity_minutes
        FROM calories_daily
        WHERE date BETWEEN ? AND ?
        ORDER BY date DESC
        """,
        (start_day.isoformat(), end_day.isoformat()),
    )

    weight_rows = fetch_all(
        """
        SELECT timestamp, weight_kg, bmi, body_fat_pct
        FROM weight
        WHERE timestamp >= ? AND timestamp < ?
        ORDER BY timestamp DESC
        """,
        (start_epoch, end_epoch),
    )
    if not weight_rows:
        latest_w = fetch_one(
            """
            SELECT timestamp, weight_kg, bmi, body_fat_pct
            FROM weight
            ORDER BY timestamp DESC
            LIMIT 1
            """
        )
        weight_rows = [latest_w] if latest_w else []

    return {
        "days": days,
        "start": start_day,
        "end": end_day,
        "steps": steps,
        "sleep": sleep,
        "hr": hr,
        "spo2": spo2,
        "stress": stress,
        "calories": calories_rows,
        "weight": weight_rows,
    }


# ---------------------------------------------------------------------------
# Day emoji helpers — для календаря
# ---------------------------------------------------------------------------
def day_emoji(steps_row: sqlite3.Row | None, sleep_row: sqlite3.Row | None) -> str:
    """Один emoji для строки дня в календаре."""
    score = 0
    if steps_row and int(steps_row["total_steps"] or 0) >= STEP_GOAL:
        score += 1
    if sleep_row:
        total = sleep_total(sleep_row)
        if total >= 420:
            score += 1
    if score == 2:
        return "🟢"
    if score == 1:
        return "🟡"
    return "🔴"


# ---------------------------------------------------------------------------
# Dashboard text — «умный» с динамическим заголовком и советом дня
# ---------------------------------------------------------------------------
def main_menu_text() -> str:
    steps = latest_steps()
    sleep = latest_sleep()
    hr = latest_hr()
    spo2 = latest_spo2()
    stress = latest_stress()
    lines = []



    # 1. Шаги
    if steps:
        steps_count = int(steps["total_steps"])
        dist_km = float(steps['distance_m']) / 1000.0
        cals = float(steps['calories'])
        lines.append(f"🚶 <b>{steps_count:,}</b> · <b>{dist_km:.1f}</b> км · <b>{cals:.0f}</b> ккал".replace(",", " "))
    else:
        lines.append("🚶 Шаги н/д")

    lines.append("")

    # 2. Сон
    if sleep:
        total_sleep = sleep_total(sleep)
        try:
            start_str = format_epoch(sleep["start_time"], False)
            end_str = format_epoch(sleep["end_time"], False)
            time_arrow = f"{start_str}→{end_str} · "
        except Exception:
            time_arrow = ""
        lines.append(f"😴 {time_arrow}<b>{format_minutes(total_sleep)}</b>")
    else:
        lines.append("😴 Сон н/д")

    lines.append("")

    # 3. Пульс, Кислород, Стресс
    metrics_parts = []
    if hr:
        metrics_parts.append(f"❤️ <b>{int(hr['value'])}</b>")
    if spo2:
        metrics_parts.append(f"🩸 <b>{float(spo2['spo2']):.0f}%</b>")
    if stress:
        metrics_parts.append(f"🧘 <b>{int(stress['value'])}</b>")

    if metrics_parts:
        lines.append(" · ".join(metrics_parts))
    else:
        lines.append("❤️ 🩸 🧘 н/д")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Day detail text
# ---------------------------------------------------------------------------
def day_text(data: dict) -> str:
    steps = data["steps"]
    sleep = data["sleep"]
    hr = data["hr"]
    spo2 = data["spo2"]
    day_str = data["date"]

    day_label = relative_day_label(day_str)

    # Заголовок без эмодзи, затем пустая строка
    lines = [f"Детали за {esc(day_str)} ({esc(day_label)})", ""]

    # Шаги
    if steps:
        steps_count = int(steps["total_steps"])
        dist_km = float(steps['distance_m']) / 1000.0
        lines.append(f"🚶 <b>Шаги:</b> {steps_count:,} · {dist_km:.1f} км".replace(",", " "))
    else:
        lines.append("🚶 Шаги: за этот день данных нет")

    # Активность и Калории
    cals_row = data.get("calories")
    if cals_row:
        total_cal = float(cals_row["total_cal"] or 0)
        active_cal = float(cals_row["active_cal"] or 0)
        stand_hours = int(cals_row["valid_stand_hours"] or 0)
        intensity_min = int(cals_row["intensity_minutes"] or 0)
        lines.append(f"🧍 <b>Активность:</b> разминки: {stand_hours}ч · интенсивность: {intensity_min} мин")
        lines.append(f"🔥 <b>Энергия:</b> всего: {total_cal:.0f} ккал (активные: {active_cal:.0f} ккал)")
    elif steps:
        cals = float(steps['calories'])
        lines.append(f"🔥 <b>Энергия:</b> {cals:.0f} ккал")

    lines.append("")

    # Сон
    if sleep:
        total_sleep = sleep_total(sleep)
        deep = int(sleep["deep_sleep_min"] or 0)
        light = int(sleep["light_sleep_min"] or 0)
        score = int(sleep["sleep_score"] or 0)
        score_part = f" · {score}/100" if score else ""

        try:
            start_str = format_epoch(sleep["start_time"], False)
            end_str = format_epoch(sleep["end_time"], False)
            time_arrow = f" · {start_str}→{end_str}"
        except Exception:
            time_arrow = ""

        lines.append(f"😴 <b>Сон:</b> {format_minutes(total_sleep)} (глубокий: {format_minutes(deep)} · легкий: {format_minutes(light)}){score_part}{time_arrow}")
    else:
        lines.append("😴 Сон: за этот день данных нет")

    lines.append("")

    # Показатели (Пульс, SpO2, Стресс, Вес)
    metrics_parts = []
    if hr and hr["count"]:
        avg_hr = int(hr["avg_value"])
        min_hr = int(hr["min_value"])
        max_hr = int(hr["max_value"])
        rest_hr_part = ""
        if sleep:
            rest_hr = resting_hr(int(sleep["start_time"]), int(sleep["end_time"]))
            if rest_hr:
                rest_hr_part = f" · во сне: {rest_hr} bpm"
        metrics_parts.append(f"❤️ <b>Пульс:</b> ср. {avg_hr} ({min_hr}–{max_hr}) bpm{rest_hr_part}")
    else:
        metrics_parts.append("❤️ Пульс: за этот день данных нет")

    # SpO2
    if spo2 and spo2["count"]:
        avg_spo2 = float(spo2["avg_value"])
        min_spo2 = float(spo2["min_value"])
        max_spo2 = float(spo2["max_value"])
        metrics_parts.append(f"🩸 <b>Кислород:</b> ср. {avg_spo2:.0f}% ({min_spo2:.0f}–{max_spo2:.0f}%) SpO2")
    else:
        metrics_parts.append("🩸 Кислород: за этот день данных нет")

    # Стресс
    stress = data.get("stress")
    if stress and stress["count"]:
        avg_str = int(stress["avg_value"])
        min_str = int(stress["min_value"])
        max_str = int(stress["max_value"])
        metrics_parts.append(f"🧘 <b>Стресс:</b> ср. {avg_str} ({min_str}–{max_str})")
    else:
        metrics_parts.append("🧘 Стресс: за этот день данных нет")

    # Вес
    weight = data.get("weight")
    if weight:
        w_kg = float(weight["weight_kg"] or 0)
        bmi_part = ""
        fat_part = ""
        if weight["bmi"]:
            bmi_part = f" · BMI: {float(weight['bmi']):.1f}"
        if weight["body_fat_pct"]:
            fat_part = f" · жир: {float(weight['body_fat_pct']):.1f}%"
        metrics_parts.append(f"⚖️ <b>Вес:</b> {w_kg:.1f} кг{bmi_part}{fat_part}")

    lines.append("\n\n".join(metrics_parts))

    # Тренировки
    workouts = data.get("workouts")
    if workouts:
        lines.append("")
        lines.append("🏋️ <b>Тренировки:</b>")
        for w in workouts:
            sport = workout_type_label(w["sport_type"])
            dur_min = int(w["duration_sec"] or 0) // 60
            dur_sec = int(w["duration_sec"] or 0) % 60
            dur_str = f"{dur_min}:{dur_sec:02d}"
            cal = float(w["calories"] or 0)
            avg_hr = int(w["avg_hr"] or 0)
            max_hr = int(w["max_hr"] or 0)

            hr_part = ""
            if avg_hr:
                hr_part = f" · ❤️ ср. {avg_hr}"
                if max_hr and max_hr != avg_hr:
                    hr_part += f" (макс {max_hr})"
                hr_part += " bpm"

            try:
                start_dt = datetime.fromtimestamp(w["start_time"], LOCAL_TZ)
                time_str = f" в {start_dt.hour:02d}:{start_dt.minute:02d}"
            except Exception:
                time_str = ""

            lines.append(f"• <b>{esc(sport)}</b>{time_str} ({dur_str} · 🔥 {cal:.0f} ккал{hr_part})")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# History / Calendar
# ---------------------------------------------------------------------------
def day_btn_label(date_str: str) -> str:
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d").date()
        month_name = RU_MONTHS[dt.month - 1]
        return f"{dt.day} {month_name}"
    except Exception:
        return date_str

def history_text(days: int = 7) -> str:
    summary = period_summary(days)
    rows = summary["steps"]
    sleep_by_day = {row["date"]: row for row in summary["sleep"]}
    all_days = sorted(
        set([r["date"] for r in rows] + list(sleep_by_day.keys())),
        reverse=True,
    )[:days]

    lines = [
        f"📅 <b>Последние {days} дней</b>",
        "",
    ]

    if not all_days:
        lines.append("Пока пусто: за этот период данных нет.")
        return "\n".join(lines)

    for d in all_days:
        steps_row = next((r for r in rows if r["date"] == d), None)
        sleep_row = sleep_by_day.get(d)
        icon = day_emoji(steps_row, sleep_row)

        try:
            dt = datetime.strptime(d, "%Y-%m-%d").date()
            date_formatted = f"{dt.day:02d}.{dt.month:02d}"
        except Exception:
            date_formatted = d

        steps_text = f"{int(steps_row['total_steps']):,} шагов".replace(",", " ") if steps_row else "шаги н/д"
        sleep_text = "сон н/д"
        if sleep_row:
            total = sleep_total(sleep_row)
            sleep_text = format_minutes(total)
        lines.append(f"{icon} <b>{date_formatted}</b>   {steps_text} · {sleep_text}")

    lines.append("")
    lines.append("Нажми на день ниже для деталей")
    return "\n".join(lines)


def history_keyboard(days: int = 7) -> InlineKeyboardMarkup:
    # Переключатели периода
    period_row = [
        InlineKeyboardButton(
            "· 7 дней ·" if days == 7 else "7 дней",
            callback_data="period_cal:7",
        ),
        InlineKeyboardButton(
            "· 30 дней ·" if days == 30 else "30 дней",
            callback_data="period_cal:30",
        ),
    ]
    buttons: list[list[InlineKeyboardButton]] = [period_row]

    day_buttons = [
        InlineKeyboardButton(day_btn_label(day), callback_data=f"day:{day}")
        for day in available_days(days)
    ]
    for idx in range(0, len(day_buttons), 3):
        buttons.append(day_buttons[idx: idx + 3])

    buttons.append([InlineKeyboardButton("⬅️ Главная", callback_data="menu:main")])
    return InlineKeyboardMarkup(buttons)


# ---------------------------------------------------------------------------
# Day navigation keyboard
# ---------------------------------------------------------------------------
def day_keyboard(current: date) -> InlineKeyboardMarkup:
    today = datetime.now(LOCAL_TZ).date()
    prev_day = current - timedelta(days=1)
    next_day = current + timedelta(days=1)

    prev_btn = InlineKeyboardButton(f"◀️ {prev_day.isoformat()}", callback_data=f"day:{prev_day.isoformat()}")
    if current >= today:
        next_btn = InlineKeyboardButton("📊 Главная", callback_data="menu:main")
    else:
        next_btn = InlineKeyboardButton(f"{next_day.isoformat()} ▶️", callback_data=f"day:{next_day.isoformat()}")

    return InlineKeyboardMarkup([
        [prev_btn, next_btn],
        [InlineKeyboardButton("📅 Календарь", callback_data="menu:history")],
    ])


# ---------------------------------------------------------------------------
# Sleep detail text
# ---------------------------------------------------------------------------
def latest_sleep_text() -> str:
    sleep = latest_sleep()
    if not sleep:
        return "😴 <b>Ночной сон</b>\n\nПока нет данных."

    hr, spo2 = sleep_window_stats(sleep)
    total_sleep = sleep_total(sleep)
    deep = int(sleep["deep_sleep_min"] or 0)
    rem = int(sleep["rem_sleep_min"] or 0)
    score = int(sleep["sleep_score"] or 0)

    import datetime as _dt
    try:
        sleep_date = _dt.datetime.strptime(sleep["date"], "%Y-%m-%d").date()
        date_formatted = f"{sleep_date.day} {RU_MONTHS[sleep_date.month - 1]}"
    except Exception:
        date_formatted = sleep["date"]

    start_str = format_epoch(sleep["start_time"], False)
    end_str = format_epoch(sleep["end_time"], False)

    rest_hr_str = "н/д"
    if sleep["start_time"] and sleep["end_time"]:
        rest_hr = resting_hr(int(sleep["start_time"]), int(sleep["end_time"]))
        if rest_hr:
            rest_hr_str = f"{rest_hr} bpm"

    deep_bar = make_sleep_bar(deep, total_sleep)
    light = int(sleep["light_sleep_min"] or 0)
    light_bar = make_sleep_bar(light, total_sleep)
    rem_bar = make_sleep_bar(rem, total_sleep)

    lines = [
        f"😴 <b>Ночной сон · {date_formatted}</b>",
        "",
        f"Длительность    <b>{format_minutes(total_sleep)}</b>",
        f"Качество        <b>{score} / 100</b>" if score else "Качество        <b>н/д</b>",
        f"Постель         <b>{start_str} — {end_str}</b>",
        f"Пульс покоя     <b>{rest_hr_str}</b>",
        "",
        f"Глубокий  <code>{deep_bar}</code>  {format_minutes(deep)}",
        f"Лёгкий    <code>{light_bar}</code>  {format_minutes(light)}",
    ]
    if rem:
        lines.append(f"REM       <code>{rem_bar}</code>  {format_minutes(rem)}")

    lines.append("")

    hr_str = "н/д"
    if hr and hr["count"]:
        hr_str = f"ср. {int(hr['avg_value'])} · диапазон {int(hr['min_value'])}–{int(hr['max_value'])}"
    lines.append(f"ЧСС во сне   {hr_str}")

    spo2_str = "н/д"
    if spo2 and spo2["count"]:
        spo2_str = f"ср. {int(spo2['avg_value'])}% · мин. {int(spo2['min_value'])}%"
    lines.append(f"SpO2 во сне  {spo2_str}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Analytics / Trends
# ---------------------------------------------------------------------------
def period_text(days: int) -> str:
    summary = period_summary(days)
    steps = summary["steps"]
    sleep_rows = summary["sleep"]

    total_steps = sum(int(row["total_steps"] or 0) for row in steps)
    avg_steps = round(total_steps / len(steps)) if steps else 0
    best_steps = max(steps, key=lambda r: int(r["total_steps"] or 0), default=None)

    sleep_totals = [
        sleep_total(row) for row in sleep_rows
    ]
    avg_sleep = round(sum(sleep_totals) / len(sleep_totals)) if sleep_totals else None
    best_sleep = max(sleep_totals) if sleep_totals else None
    goal_days = sum(1 for r in steps if int(r["total_steps"] or 0) >= STEP_GOAL)

    hr = summary["hr"]
    spo2 = summary["spo2"]
    stress = summary["stress"]
    cals_rows = summary["calories"]
    weight_rows = summary["weight"]

    start_date = summary["start"]
    end_date = summary["end"]
    if start_date.month == end_date.month:
        month_name = RU_MONTHS[start_date.month - 1]
        date_range = f"{start_date.day}–{end_date.day} {month_name}"
    else:
        start_month = RU_MONTHS[start_date.month - 1]
        end_month = RU_MONTHS[end_date.month - 1]
        date_range = f"{start_date.day} {start_month} — {end_date.day} {end_month}"

    avg_total_cal = None
    avg_active_cal = None
    avg_stand_hours = None
    avg_intensity_min = None

    if cals_rows:
        valid_cals = [float(r["total_cal"]) for r in cals_rows if r["total_cal"] is not None]
        valid_active = [float(r["active_cal"]) for r in cals_rows if r["active_cal"] is not None]
        valid_stand = [int(r["valid_stand_hours"]) for r in cals_rows if r["valid_stand_hours"] is not None]
        valid_intensity = [int(r["intensity_minutes"]) for r in cals_rows if r["intensity_minutes"] is not None]

        if valid_cals:
            avg_total_cal = round(sum(valid_cals) / len(valid_cals))
        if valid_active:
            avg_active_cal = round(sum(valid_active) / len(valid_active))
        if valid_stand:
            avg_stand_hours = round(sum(valid_stand) / len(valid_stand))
        if valid_intensity:
            avg_intensity_min = round(sum(valid_intensity) / len(valid_intensity))

    stress_str = "н/д"
    if stress and stress["count"]:
        stress_str = f"ср. {int(stress['avg_value'])} · диапазон {int(stress['min_value'])}–{int(stress['max_value'])}"

    weight_str = None
    if weight_rows:
        latest_weight = weight_rows[0]
        w_kg = float(latest_weight["weight_kg"] or 0)
        bmi_val = latest_weight["bmi"]
        fat_val = latest_weight["body_fat_pct"]

        weight_str = f"{w_kg:.1f} кг"
        if bmi_val:
            weight_str += f" (BMI: {float(bmi_val):.1f}"
            if fat_val:
                weight_str += f" · жир: {float(fat_val):.1f}%"
            weight_str += ")"

    period_label = "Все время" if days >= 3650 else f"{days} дней"
    lines = [
        f"📊 <b>Тренды · {period_label} · {date_range}</b>",
        "",
        f"🚶 <b>Шаги всего</b>       {total_steps:,}".replace(",", " "),
        f"   В среднем / день  {avg_steps:,}".replace(",", " "),
        f"   Норма {STEP_GOAL // 1000}k         {goal_days} из {len(steps)} дней",
    ]
    if best_steps:
        try:
            best_dt = datetime.strptime(best_steps["date"], "%Y-%m-%d").date()
            best_date_str = f"{best_dt.day:02d}.{best_dt.month:02d}"
        except Exception:
            best_date_str = best_steps["date"]
        lines.append(f"   🏆 Лучший день    {best_date_str} · {int(best_steps['total_steps']):,}".replace(",", " "))

    lines.append("")

    if avg_total_cal is not None:
        lines.append("🧍 <b>Активность ср.</b>")
        lines.append(f"   Расход энергии    {avg_total_cal} ккал (активные: {avg_active_cal} ккал)")
        stand_part = f"{avg_stand_hours}ч" if avg_stand_hours is not None else "н/д"
        intens_part = f"{avg_intensity_min} мин" if avg_intensity_min is not None else "н/д"
        lines.append(f"   Часы разминок     {stand_part} · интенсивность: {intens_part}")
        lines.append("")

    lines.append("😴 <b>Сон среднее</b>      " + (format_minutes(avg_sleep) if avg_sleep else "н/д"))
    if best_sleep:
        lines.append(f"   Лучшая ночь      {format_minutes(best_sleep)}")

    lines.append("")
    hr_str = "н/д"
    if hr and hr["count"]:
        hr_str = f"{int(hr['avg_value'])} bpm · {int(hr['min_value'])}–{int(hr['max_value'])}"
    lines.append(f"❤️ <b>Пульс ср.</b>        {hr_str}")

    spo2_str = "н/д"
    if spo2 and spo2["count"]:
        spo2_str = f"{float(spo2['avg_value']):.1f}% · мин. {int(spo2['min_value'])}%"
    lines.append(f"🩸 <b>SpO2 ср.</b>          {spo2_str}")

    # Стресс
    lines.append(f"🧘 <b>Стресс ср.</b>        {stress_str}")

    # Вес
    if weight_str:
        lines.append(f"⚖️ <b>Вес (последний)</b>  {weight_str}")

    lines.extend(["", "<i>Берегите здоровье!</i>"])
    return "\n".join(lines)


def trends_keyboard(days: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(
                    "· 7 дней ·" if days == 7 else "7 дней",
                    callback_data="period:7d",
                ),
                InlineKeyboardButton(
                    "· 30 дней ·" if days == 30 else "30 дней",
                    callback_data="period:30d",
                ),
            ],
            [
                InlineKeyboardButton("· Все время ·" if days >= 3650 else "Все время", callback_data="period:all"),
                InlineKeyboardButton("🏋️ Тренировки", callback_data="menu:workouts"),
            ],
            [InlineKeyboardButton("⬅️ Главная", callback_data="menu:main")],
        ]
    )


# ---------------------------------------------------------------------------
# Workouts screen
# ---------------------------------------------------------------------------
def workouts_text(limit: int = 10) -> str:
    workouts = recent_workouts(limit)
    lines = ["🏋️ <b>Тренировки</b>", ""]
    if not workouts:
        lines.append("Пока нет записей. Синхронизация загрузит тренировки автоматически.")
        return "\n".join(lines)

    for w in workouts:
        sport = workout_type_label(w["sport_type"])
        start = format_epoch(w["start_time"])
        dur_min = int(w["duration_sec"] or 0) // 60
        dur_sec = int(w["duration_sec"] or 0) % 60
        dur_str = f"{dur_min}:{dur_sec:02d}"
        cal = float(w["calories"] or 0)
        avg_hr = int(w["avg_hr"] or 0)
        max_hr = int(w["max_hr"] or 0)

        lines.append(f"🏋️ <b>{esc(sport)}</b>")
        lines.append(f"   🗓 {esc(start)}")
        lines.append(f"   ⏱ {dur_str} · 🔥 {cal:.0f} ккал")
        if avg_hr:
            lines.append(f"   ❤️ ср. {avg_hr} bpm", )
        if max_hr and max_hr != avg_hr:
            lines[-1] = lines[-1] + f" · макс {max_hr} bpm"
        lines.append("")

    lines.append("<i>Последние тренировки из Xiaomi Health.</i>")
    return "\n".join(lines)


def workouts_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("⬅️ Тренды", callback_data="menu:trends")]]
    )




# ---------------------------------------------------------------------------
# Service menu
# ---------------------------------------------------------------------------
def db_total_records() -> int:
    if not health_db_exists():
        return 0
    conn = health_conn()
    tables = ["steps_daily", "sleep_daily", "sleep_stages", "heart_rate", "blood_oxygen", "stress", "calories_daily", "weight", "workouts"]
    total = 0
    try:
        for table in tables:
            exists = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                (table,),
            ).fetchone()
            if exists:
                total += conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except Exception:
        pass
    finally:
        conn.close()
    return total

def more_text() -> str:
    status = read_status_file()
    last_sync_epoch = status.get("last_sync")
    last_sync_str = format_relative_time(last_sync_epoch) if last_sync_epoch else "н/д"

    interval_min = int(SETTINGS.sync_interval) // 60
    db_records = db_total_records()

    return (
        "⚙️ <b>Сервис</b>\n\n"
        f"Устройство       <b>Mi Band</b>\n"
        f"Последний синк   <b>{last_sync_str}</b>\n"
        f"Интервал         <b>{interval_min} мин</b>\n"
        f"Записей в БД     <b>{db_records:,}</b>".replace(",", " ")
    )


def more_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("🔄 Синхронизировать", callback_data="menu:sync")],
            [
                InlineKeyboardButton("💾 Экспорт ZIP", callback_data="menu:export"),
                InlineKeyboardButton("📊 Статус БД", callback_data="menu:db_status"),
            ],
            [InlineKeyboardButton("⬅️ Главная", callback_data="menu:main")],
        ]
    )


def db_status_text() -> str:
    status = read_status_file()
    lines = ["🧰 <b>Статус базы данных</b>", ""]
    if not health_db_exists():
        return "🧰 <b>Статус базы данных</b>\n\nБаза пока не создана."

    conn = health_conn()
    try:
        tables = ["steps_daily", "sleep_daily", "sleep_stages", "heart_rate", "blood_oxygen",
                  "stress", "calories_daily", "weight", "workouts"]
        for table in tables:
            exists = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                (table,),
            ).fetchone()
            if not exists:
                lines.append(f"• {table}: таблицы нет")
                continue
            count = conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"]
            lines.append(f"• {table}: <b>{count:,}</b> строк".replace(",", " "))
    finally:
        conn.close()

    last_sync_epoch = status.get("last_sync")
    last_sync = format_epoch(last_sync_epoch) if last_sync_epoch else status.get("last_sync_time", "н/д")
    lines.extend(
        [
            "",
            f"Путь: <code>{esc(DB_PATH)}</code>",
            f"Последний синк: {esc(last_sync)}",
        ]
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def zip_export() -> io.BytesIO:
    return storage.zip_export(SETTINGS, get_current_user_id())


# ---------------------------------------------------------------------------
# Xiaomi onboarding
# ---------------------------------------------------------------------------
def onboarding_text() -> str:
    return (
        "🔐 <b>Авторизация Xiaomi</b>\n\n"
        "Для первого запуска нужен вход в Xiaomi Fitness. Нажми кнопку ниже, подтверди вход, "
        "а я дождусь ответа и сразу запущу синхронизацию."
    )


def onboarding_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("🔐 Войти в Xiaomi", callback_data="auth:start")]]
    )


def normalize_login_url(url: str | None) -> str:
    if not url:
        return ""
    url = url.strip()
    if url.startswith("//"):
        return f"https:{url}"
    return url


def xiaomi_wait_keyboard(login_url: str, qr_image_url: str) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    login_url = normalize_login_url(login_url)
    qr_image_url = normalize_login_url(qr_image_url)
    if login_url:
        rows.append([InlineKeyboardButton("🔐 Открыть вход Xiaomi", url=login_url)])
    if qr_image_url:
        rows.append([InlineKeyboardButton("▦ Открыть QR-код", url=qr_image_url)])
    return InlineKeyboardMarkup(rows or [[InlineKeyboardButton("🔄 Повторить", callback_data="auth:start")]])


def auth_retry_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("🔐 Войти заново", callback_data="auth:relogin")],
            [InlineKeyboardButton("⬅️ Сервис", callback_data="menu:more")],
        ]
    )


async def show_onboarding(update: Update, context: ContextTypes.DEFAULT_TYPE, force_new: bool = False) -> None:
    await update_menu(update, context, onboarding_text(), onboarding_keyboard(), force_new=force_new)


async def start_xiaomi_login(update: Update, context: ContextTypes.DEFAULT_TYPE, *, force: bool = False) -> None:
    if has_xiaomi_token() and not force:
        await show_main_menu(update, context)
        return
    if AUTH_LOCK.locked():
        await update_menu(
            update,
            context,
            "🔐 <b>Авторизация Xiaomi</b>\n\nУже жду подтверждение входа. Открой ссылку из предыдущего сообщения.",
            onboarding_keyboard(),
        )
        return

    async with AUTH_LOCK:
        if has_xiaomi_token() and not force:
            await show_main_menu(update, context)
            return

        await update_menu(
            update,
            context,
            "🔐 <b>Авторизация Xiaomi</b>\n\nГотовлю ссылку входа…",
            None,
        )
        auth = XiaomiAuth()

        async def qr_callback(qr_image_url: str, login_url: str) -> None:
            await update_menu(
                update,
                context,
                "🔐 <b>Авторизация Xiaomi</b>\n\nОткрой ссылку, подтверди вход и вернись сюда. Я жду результат.",
                xiaomi_wait_keyboard(login_url, qr_image_url),
            )

        try:
            token = await auth.login_qr(qr_callback=qr_callback, max_wait=300)
            token_path = get_xiaomi_token_path()
            if token_path is None:
                raise ConfigError("Не удалось определить путь для Xiaomi token")
            save_auth_token(token, token_path)
            await update_menu(
                update,
                context,
                "✅ <b>Авторизация Xiaomi</b>\n\nВход подтверждён. Запускаю первую синхронизацию…",
                None,
            )
            await run_initial_sync_after_login(update, context)
        except Exception as e:
            logger.exception("Xiaomi login failed")
            await update_menu(
                update,
                context,
                f"⚠️ <b>Авторизация Xiaomi</b>\n\nНе удалось войти: {esc(e)}",
                auth_retry_keyboard(),
            )
        finally:
            await auth.close()


async def run_initial_sync_after_login(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if SYNC_LOCK.locked():
        await update_menu(
            update,
            context,
            "✅ <b>Авторизация Xiaomi</b>\n\nВход готов. Синхронизация уже идёт, открою меню.",
            main_keyboard(),
        )
        return

    async with SYNC_LOCK:
        import dataclasses
        initial_settings = dataclasses.replace(SETTINGS, query_duration=30)
        result = await run_sync(get_current_user_id(), initial_settings)

    if result.success:
        await show_main_menu(update, context)
        return

    detail = f"\n\nПричина: {esc(result.error)}" if result.error else ""
    await update_menu(
        update,
        context,
        f"⚠️ <b>Первая синхронизация</b>\n\nАвторизация сохранена, но данные не обновились.{detail}",
        auth_retry_keyboard(),
    )


# ---------------------------------------------------------------------------
# Menu keyboards
# ---------------------------------------------------------------------------
def main_keyboard() -> InlineKeyboardMarkup:
    is_en = os.getenv("BOT_LANG") == "en"
    if is_en:
        return InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton("😴 Sleep", callback_data="menu:sleep"),
                    InlineKeyboardButton("📊 Weekly", callback_data="menu:trends"),
                ],
                [
                    InlineKeyboardButton("📅 History", callback_data="menu:history"),
                    InlineKeyboardButton("⚙️ Settings", callback_data="menu:more"),
                ],
            ]
        )
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("😴 Сон", callback_data="menu:sleep"),
                InlineKeyboardButton("📊 За неделю", callback_data="menu:trends"),
            ],
            [
                InlineKeyboardButton("📅 История", callback_data="menu:history"),
                InlineKeyboardButton("⚙️ Настройки", callback_data="menu:more"),
            ],
        ]
    )


def back_keyboard(back_to: str = "menu:main") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Назад", callback_data=back_to)]])


# ---------------------------------------------------------------------------
# Handlers: show_* functions
# ---------------------------------------------------------------------------
async def show_main_menu(
    update: Update, context: ContextTypes.DEFAULT_TYPE, force_new: bool = False
) -> None:
    await update_menu(update, context, main_menu_text(), main_keyboard(), force_new=force_new)


async def show_history(
    update: Update, context: ContextTypes.DEFAULT_TYPE, days: int = 7
) -> None:
    await update_menu(update, context, history_text(days), history_keyboard(days))


async def show_day(
    update: Update, context: ContextTypes.DEFAULT_TYPE, day_str: str
) -> None:
    day_value = parse_day(day_str)
    await update_menu(
        update,
        context,
        day_text(day_summary(day_str)),
        day_keyboard(day_value),
    )


async def run_manual_sync(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    if not has_xiaomi_token():
        await show_onboarding(update, context)
        return
    if not run_sync:
        await update_menu(
            update,
            context,
            "🔄 <b>Синхронизация</b>\n\nМодуль синхронизации не найден.",
            back_keyboard("menu:more"),
        )
        return
    if SYNC_LOCK.locked():
        await update_menu(
            update,
            context,
            "🔄 <b>Синхронизация</b>\n\nУже идёт обновление. Подожди завершения.",
            back_keyboard("menu:more"),
        )
        return

    await update_menu(
        update,
        context,
        "🔄 <b>Синхронизация</b>\n\nЗабираю данные из Xiaomi Fitness…",
        back_keyboard("menu:more"),
    )
    async with SYNC_LOCK:
        try:
            result = await run_sync(get_current_user_id(), SETTINGS)
        except Exception as e:
            logger.exception("Manual sync failed")
            await update_menu(
                update,
                context,
                f"🔄 <b>Синхронизация</b>\n\nОшибка запуска: {esc(e)}",
                back_keyboard("menu:more"),
            )
            return

    if result.success:
        await update_menu(
            update,
            context,
            "✅ <b>Синхронизация</b>\n\nГотово, данные обновлены.",
            InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("📊 На главную", callback_data="menu:main")],
                    [InlineKeyboardButton("⬅️ Сервис", callback_data="menu:more")],
                ]
            ),
        )
    else:
        detail = f"\n\nПричина: {esc(result.error)}" if result.error else ""
        keyboard = auth_retry_keyboard() if "Token" in (result.error or "") else back_keyboard("menu:more")
        await update_menu(
            update,
            context,
            f"⚠️ <b>Синхронизация</b>\n\nНе вышло обновиться.{detail}",
            keyboard,
        )


async def export_data(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_chat:
        return
    if not health_db_exists():
        await update_menu(
            update,
            context,
            "💾 <b>Экспорт</b>\n\nБаза данных пока не создана.",
            back_keyboard("menu:more"),
        )
        return

    await update_menu(update, context, "💾 <b>Экспорт</b>\n\nСобираю ZIP…", None)
    try:
        export_file = zip_export()
        if export_file.getbuffer().nbytes == 0:
            await update_menu(
                update,
                context,
                "💾 <b>Экспорт</b>\n\nВ базе нет данных.",
                back_keyboard("menu:more"),
            )
            return
        await context.bot.send_document(
            chat_id=update.effective_chat.id,
            document=export_file,
            filename=export_file.name,
            caption="💚 MiBand Health CSV Export",
        )
        await update_menu(
            update,
            context,
            "✅ <b>Экспорт</b>\n\nZIP с CSV-таблицами отправлен выше.",
            back_keyboard("menu:more"),
        )
    except Exception as e:
        logger.exception("Export failed")
        await update_menu(
            update,
            context,
            f"⚠️ <b>Экспорт</b>\n\nОшибка: {esc(e)}",
            back_keyboard("menu:more"),
        )


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
@with_user_context
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed(update):
        uid = update.effective_user.id if update.effective_user else "unknown"
        logger.warning("Unauthorized access from user: %s", uid)
        return
    await safe_delete(update.message)
    if not has_xiaomi_token():
        await show_onboarding(update, context, force_new=True)
        return
    await show_main_menu(update, context, force_new=True)


@with_user_context
async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed(update):
        return
    await safe_delete(update.message)
    await update_menu(update, context, db_status_text(), back_keyboard("menu:more"))


@with_user_context
async def cmd_sync(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed(update):
        return
    await safe_delete(update.message)
    if not has_xiaomi_token():
        await show_onboarding(update, context)
        return
    await run_manual_sync(update, context)


@with_user_context
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_allowed(update):
        return
    text = update.message.text if update.message else ""
    await safe_delete(update.message)
    if not has_xiaomi_token():
        await show_onboarding(update, context)
        return

    if "Сон" in text or "Sleep" in text:
        await update_menu(update, context, latest_sleep_text(), back_keyboard())
    elif "За неделю" in text or "Weekly" in text:
        await update_menu(update, context, period_text(7), trends_keyboard(7))
    elif "История" in text or "History" in text:
        await show_history(update, context, 7)
    elif "Настройки" in text or "Settings" in text:
        await update_menu(update, context, more_text(), more_keyboard())
    else:
        await show_main_menu(update, context)


# ---------------------------------------------------------------------------
# Callback router
# ---------------------------------------------------------------------------
@with_user_context
async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query:
        await query.answer()
    if not is_allowed(update):
        return

    data = query.data if query else "menu:main"

    if data in {"auth:start", "auth:relogin"}:
        await start_xiaomi_login(update, context, force=data == "auth:relogin")

    elif not has_xiaomi_token():
        await show_onboarding(update, context)

    elif data == "menu:main":
        await show_main_menu(update, context)

    elif data == "menu:history":
        await show_history(update, context, 7)

    elif data.startswith("period_cal:"):
        # Переключение числа дней в Календаре
        days = int(data.split(":")[1])
        await show_history(update, context, days)

    elif data == "menu:sleep":
        await update_menu(
            update,
            context,
            latest_sleep_text(),
            back_keyboard(),
        )

    elif data == "menu:trends":
        await update_menu(update, context, period_text(7), trends_keyboard(7))

    elif data.startswith("period:"):
        days = 3650 if data == "period:all" else 7 if data == "period:7d" else 30
        await update_menu(update, context, period_text(days), trends_keyboard(days))

    elif data.startswith("day:"):
        try:
            await show_day(update, context, data.split(":", 1)[1])
        except Exception as e:
            logger.exception("Failed to show day")
            await update_menu(
                update,
                context,
                f"📊 <b>День</b>\n\nНе удалось открыть: {esc(e)}",
                back_keyboard("menu:history"),
            )

    elif data == "menu:workouts":
        await update_menu(update, context, workouts_text(), workouts_keyboard())

    elif data == "menu:more":
        await update_menu(update, context, more_text(), more_keyboard())

    elif data == "menu:sync":
        await run_manual_sync(update, context)

    elif data == "menu:export":
        await export_data(update, context)

    elif data == "menu:db_status":
        await update_menu(update, context, db_status_text(), back_keyboard("menu:more"))

    else:
        await show_main_menu(update, context)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    global SETTINGS, BOT_TOKEN, ALLOWED_USER_ID, DB_PATH
    try:
        SETTINGS = Settings.from_env(require_bot=True)
    except ConfigError as exc:
        logger.error("%s", exc)
        sys.exit(1)
    BOT_TOKEN = SETTINGS.telegram_bot_token
    ALLOWED_USER_ID = SETTINGS.telegram_allowed_user_id
    allowed_ids = SETTINGS.telegram_allowed_user_ids
    if allowed_ids:
        print(f"Запуск бота для пользователей: {allowed_ids}...")
        for uid in allowed_ids:
            db_p = SETTINGS.user_db_path(uid)
            storage.init_health_db(db_p)
    else:
        DB_PATH = str(SETTINGS.db_path)
        print("Бот запущен. Отправьте /start в Telegram чтобы привязать аккаунт.")
        storage.init_health_db(Path(DB_PATH))


    init_state_db()
    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(start_background_tasks)
        .post_shutdown(stop_background_tasks)
        .build()
    )
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("sync", cmd_sync))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.ALL, handle_message))
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
