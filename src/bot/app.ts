import type { SQLQueryBindings } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { Bot, type Context, InlineKeyboard, InputFile } from "grammy";
import type { AppConfig } from "../config.js";
import { canonicalUserDbPath, canonicalUserStatusPath, tokenPath, userDbPath } from "../config.js";
import { log } from "../logger.js";
import {
  fetchAll,
  fetchOne,
  getUserLocale,
  getUserMenuMessageId,
  healthDbExists,
  initHealthDb,
  readStatus,
  setUserLocale,
  setUserMenuMessageId,
  zipExport,
} from "../storage/health.js";
import { saveAuthToken, writeTextAtomic } from "../storage/secure-files.js";
import { runSync, type SyncResult } from "../sync.js";
import { XiaomiAuth } from "../xiaomi/client.js";
import { epoch, esc, minutes, relativeDay, rowNumber, rowString, sleepTotal, workoutType } from "./formatting.js";
import { isLocale, LOCALE_NAMES, LOCALES, type Locale, t } from "./i18n.js";

const STEP_GOAL = 10_000;
const USER_NAMES: Record<number, string> = { 7629366167: "Алексей", 1260959328: "Маша" };
type BotContext = Context;
type TaskHandle = { stop: () => Promise<void> };

function localeOf(config: AppConfig, uid: number): Locale {
  return getUserLocale(config, uid);
}

function numberLocale(locale: Locale): string {
  return locale === "ru" ? "ru-RU" : locale === "es" ? "es-ES" : "en-GB";
}

function uidOf(context: BotContext): number | null {
  const value = context.from?.id;
  return value === undefined ? null : value;
}

function allowed(context: BotContext, config: AppConfig): boolean {
  const uid = uidOf(context);
  if (uid === null) return false;
  if (config.allowedUserIds.length > 0) return config.allowedUserIds.includes(uid);
  config.allowedUserIds.push(uid);
  writeTextAtomic(`${config.dataDir}/allowed_user.id`, String(uid));
  log("info", "Telegram owner bound", { userId: uid });
  return true;
}

function userDbReady(config: AppConfig, uid: number): boolean {
  const path = canonicalUserDbPath(config, uid);
  if (!existsSync(path)) initHealthDb(path);
  return healthDbExists(config, uid);
}

function dbRow(
  config: AppConfig,
  uid: number,
  query: string,
  params: SQLQueryBindings[] = [],
): Record<string, unknown> | null {
  userDbReady(config, uid);
  return fetchOne(config, uid, query, params);
}

function dbRows(
  config: AppConfig,
  uid: number,
  query: string,
  params: SQLQueryBindings[] = [],
): Record<string, unknown>[] {
  userDbReady(config, uid);
  return fetchAll(config, uid, query, params);
}

function mainMenuText(config: AppConfig, uid: number): string {
  const locale = localeOf(config, uid);
  const steps = dbRow(
    config,
    uid,
    "SELECT date,total_steps,calories,distance_m,last_sync FROM steps_daily ORDER BY date DESC LIMIT 1",
  );
  const sleep = dbRow(
    config,
    uid,
    "SELECT date,light_sleep_min,deep_sleep_min,start_time,end_time,COALESCE(rem_sleep_min,0) rem_sleep_min,COALESCE(awake_min,0) awake_min,COALESCE(total_duration_min,0) total_duration_min,COALESCE(sleep_score,0) sleep_score FROM sleep_daily ORDER BY date DESC LIMIT 1",
  );
  const hr = dbRow(config, uid, "SELECT timestamp,value FROM heart_rate ORDER BY timestamp DESC LIMIT 1");
  const spo2 = dbRow(config, uid, "SELECT timestamp,spo2,type FROM blood_oxygen ORDER BY timestamp DESC LIMIT 1");
  const stress = dbRow(config, uid, "SELECT timestamp,value FROM stress ORDER BY timestamp DESC LIMIT 1");
  const lines: string[] = [];
  if (steps) {
    const count = rowNumber(steps, "total_steps");
    lines.push(
      `🚶 <b>${count.toLocaleString(numberLocale(locale))}</b> · <b>${(rowNumber(steps, "distance_m") / 1000).toFixed(1)}</b> ${t(locale, "common.km")} · <b>${rowNumber(steps, "calories").toFixed(0)}</b> ${t(locale, "common.kcal")}`,
    );
  } else lines.push(t(locale, "main.no-steps"));
  lines.push("");
  if (sleep) {
    lines.push(
      `😴 ${epoch(rowNumber(sleep, "start_time"), false, locale, config.TZ)}→${epoch(rowNumber(sleep, "end_time"), false, locale, config.TZ)} · <b>${minutes(sleepTotal(sleep), locale)}</b>`,
    );
  } else lines.push(t(locale, "main.no-sleep"));
  lines.push("");
  const metrics: string[] = [];
  if (hr) metrics.push(`❤️ <b>${rowNumber(hr, "value")}</b>`);
  if (spo2) metrics.push(`🩸 <b>${rowNumber(spo2, "spo2").toFixed(0)}%</b>`);
  if (stress) metrics.push(`🧘 <b>${rowNumber(stress, "value")}</b>`);
  lines.push(metrics.length ? metrics.join(" · ") : t(locale, "main.no-metrics"));
  const status = readStatus(config, uid);
  if (status.last_sync_time) lines.push("", `🕒 ${esc(status.last_sync_time)}`);
  return lines.join("\n");
}

function workoutsText(config: AppConfig, uid: number): string {
  const locale = localeOf(config, uid);
  const rows = dbRows(
    config,
    uid,
    "SELECT sport_type,start_time,duration_sec,calories,avg_hr FROM workouts ORDER BY start_time DESC LIMIT 10",
  );
  if (!rows.length) return `🏋️ <b>${t(locale, "menu.workouts")}</b>\n\n${t(locale, "workouts.empty")}`;
  return [
    t(locale, "workouts.title"),
    "",
    ...rows.map(
      (row) =>
        `• ${workoutType(row.sport_type, locale)} · ${epoch(rowNumber(row, "start_time"), false, locale, config.TZ)} · ${Math.round(rowNumber(row, "duration_sec") / 60)} ${t(locale, "common.minutes")} · ${Math.round(rowNumber(row, "calories"))} ${t(locale, "common.kcal")} · ${rowNumber(row, "avg_hr")} bpm`,
    ),
  ].join("\n");
}

function statusText(config: AppConfig, uid: number): string {
  const locale = localeOf(config, uid);
  const status = readStatus(config, uid);
  const tables = [
    "steps_daily",
    "sleep_daily",
    "sleep_stages",
    "heart_rate",
    "blood_oxygen",
    "stress",
    "calories_daily",
    "weight",
    "workouts",
  ];
  const lines = [t(locale, "status.title"), ""];
  for (const table of tables) {
    const count = dbRow(config, uid, `SELECT COUNT(*) AS count FROM ${table}`);
    lines.push(
      `• ${table}: <b>${rowNumber(count, "count").toLocaleString(numberLocale(locale))}</b> ${t(locale, "status.rows")}`,
    );
  }
  lines.push(
    "",
    `${t(locale, "status.path")}: <code>${esc(userDbPath(config, uid))}</code>`,
    `${t(locale, "status.last-sync")}: ${esc(String(status.last_sync_time ?? t(locale, "common.na")))}`,
  );
  return lines.join("\n");
}

function zonedDateParts(value: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function localDay(timeZone: string, offset = 0): string {
  const parts = zonedDateParts(Date.now(), timeZone);
  const value = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offset));
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function timeZoneOffsetMinutes(value: number, timeZone: string): number {
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(value)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-])(\d{2})(?::(\d{2}))?$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "+" ? minutes : -minutes;
}

function zonedMidnight(day: string, timeZone: string): number {
  const naive = Date.parse(`${day}T00:00:00Z`);
  const candidate = naive - timeZoneOffsetMinutes(naive, timeZone) * 60_000;
  const corrected = naive - timeZoneOffsetMinutes(candidate, timeZone) * 60_000;
  return Math.floor(corrected / 1000);
}

function dayEpochBounds(day: string, timeZone: string): [number, number] {
  const nextDay = new Date(`${day}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const start = zonedMidnight(day, timeZone);
  return [start, zonedMidnight(nextDay.toISOString().slice(0, 10), timeZone)];
}

function formatWeekday(day: string, locale: Locale, timeZone: string): string {
  const value = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat(numberLocale(locale), { weekday: "short", timeZone }).format(value).replace(".", "");
}

function averageBedtime(rows: Record<string, unknown>[], timeZone: string): number | null {
  const offsets = rows
    .map((row) => rowNumber(row, "start_time"))
    .filter(Boolean)
    .map((time) => {
      const hour = Number(
        new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(time * 1000),
      );
      const minute = Number(new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone }).format(time * 1000));
      const offset = hour * 60 + minute;
      return offset > 720 ? offset - 1440 : offset;
    });
  return offsets.length ? offsets.reduce((sum, value) => sum + value, 0) / offsets.length : null;
}

function formatBedtime(value: number | null, locale: Locale): string {
  if (value === null) return t(locale, "common.na");
  const minutesValue = ((Math.round(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutesValue / 60)).padStart(2, "0")}:${String(minutesValue % 60).padStart(2, "0")}`;
}

function metricStats(
  config: AppConfig,
  uid: number,
  table: string,
  field: string,
  start: number,
  end: number,
): Record<string, unknown> | null {
  return dbRow(
    config,
    uid,
    `SELECT COUNT(*) AS count,ROUND(AVG(${field}),1) AS avg_value,MIN(${field}) AS min_value,MAX(${field}) AS max_value FROM ${table} WHERE timestamp >= ? AND timestamp < ?`,
    [start, end],
  );
}

function daySummary(config: AppConfig, uid: number, day: string): Record<string, unknown> {
  const [start, end] = dayEpochBounds(day, config.TZ);
  const sleep = dbRow(
    config,
    uid,
    "SELECT date,light_sleep_min,deep_sleep_min,start_time,end_time,COALESCE(rem_sleep_min,0) rem_sleep_min,COALESCE(awake_min,0) awake_min,COALESCE(total_duration_min,0) total_duration_min,COALESCE(sleep_score,0) sleep_score FROM sleep_daily WHERE date = ?",
    [day],
  );
  return {
    date: day,
    steps: dbRow(config, uid, "SELECT date,total_steps,calories,distance_m,last_sync FROM steps_daily WHERE date = ?", [
      day,
    ]),
    sleep,
    hr: metricStats(config, uid, "heart_rate", "value", start, end),
    spo2: metricStats(config, uid, "blood_oxygen", "spo2", start, end),
    stress: metricStats(config, uid, "stress", "value", start, end),
    calories: dbRow(
      config,
      uid,
      "SELECT total_cal,active_cal,valid_stand_hours,intensity_minutes FROM calories_daily WHERE date = ?",
      [day],
    ),
    weight: dbRow(
      config,
      uid,
      "SELECT weight_kg,bmi,body_fat_pct FROM weight WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1",
      [end],
    ),
    workouts: dbRows(
      config,
      uid,
      "SELECT workout_id,sport_type,start_time,end_time,duration_sec,calories,avg_hr,max_hr,min_hr FROM workouts WHERE start_time >= ? AND start_time < ? ORDER BY start_time ASC",
      [start, end],
    ),
  };
}

function availableDays(config: AppConfig, uid: number, limit: number): string[] {
  return dbRows(
    config,
    uid,
    "SELECT date FROM (SELECT date FROM steps_daily UNION SELECT date FROM sleep_daily) ORDER BY date DESC LIMIT ?",
    [limit],
  ).map((row) => rowString(row, "date"));
}

function periodSummary(config: AppConfig, uid: number, days: number): Record<string, unknown> {
  const end = localDay(config.TZ);
  const start = localDay(config.TZ, -(Math.max(1, days) - 1));
  const [startEpoch] = dayEpochBounds(start, config.TZ);
  const [, endEpoch] = dayEpochBounds(end, config.TZ);
  let weight = dbRows(
    config,
    uid,
    "SELECT timestamp,weight_kg,bmi,body_fat_pct FROM weight WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC",
    [startEpoch, endEpoch],
  );
  if (!weight.length) {
    const latest = dbRow(
      config,
      uid,
      "SELECT timestamp,weight_kg,bmi,body_fat_pct FROM weight ORDER BY timestamp DESC LIMIT 1",
    );
    if (latest) weight = [latest];
  }
  return {
    start,
    end,
    steps: dbRows(
      config,
      uid,
      "SELECT date,total_steps,calories,distance_m FROM steps_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC",
      [start, end],
    ),
    sleep: dbRows(
      config,
      uid,
      "SELECT date,light_sleep_min,deep_sleep_min,start_time,end_time,COALESCE(rem_sleep_min,0) rem_sleep_min,COALESCE(awake_min,0) awake_min,COALESCE(total_duration_min,0) total_duration_min,COALESCE(sleep_score,0) sleep_score FROM sleep_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC",
      [start, end],
    ),
    hr: metricStats(config, uid, "heart_rate", "value", startEpoch, endEpoch),
    spo2: metricStats(config, uid, "blood_oxygen", "spo2", startEpoch, endEpoch),
    stress: metricStats(config, uid, "stress", "value", startEpoch, endEpoch),
    calories: dbRows(
      config,
      uid,
      "SELECT date,total_cal,active_cal,valid_stand_hours,intensity_minutes FROM calories_daily WHERE date BETWEEN ? AND ? ORDER BY date DESC",
      [start, end],
    ),
    weight,
  };
}

function dayEmoji(steps: Record<string, unknown> | null, sleep: Record<string, unknown> | null): string {
  let score = 0;
  if (steps && rowNumber(steps, "total_steps") >= STEP_GOAL) score += 1;
  if (sleep && sleepTotal(sleep) >= 420) score += 1;
  return score === 2 ? "🟢" : score === 1 ? "🟡" : "🔴";
}

function sleepText(config: AppConfig, uid: number): string {
  const locale = localeOf(config, uid);
  const sleep = dbRow(
    config,
    uid,
    "SELECT date,light_sleep_min,deep_sleep_min,start_time,end_time,COALESCE(rem_sleep_min,0) rem_sleep_min,COALESCE(awake_min,0) awake_min,COALESCE(total_duration_min,0) total_duration_min,COALESCE(sleep_score,0) sleep_score FROM sleep_daily ORDER BY date DESC LIMIT 1",
  );
  if (!sleep) return `😴 <b>${t(locale, "sleep.title")}</b>\n\n${t(locale, "sleep.empty")}`;
  const [start, end] = [rowNumber(sleep, "start_time"), rowNumber(sleep, "end_time")];
  const hr = start && end ? metricStats(config, uid, "heart_rate", "value", start, end) : null;
  const spo2 = start && end ? metricStats(config, uid, "blood_oxygen", "spo2", start, end) : null;
  const rest =
    start && end
      ? dbRow(
          config,
          uid,
          "SELECT MIN(value) AS min_hr FROM heart_rate WHERE timestamp >= ? AND timestamp < ? AND value > 30",
          [start, end],
        )
      : null;
  const date = new Date(`${rowString(sleep, "date")}T12:00:00Z`);
  const dateLabel = new Intl.DateTimeFormat(numberLocale(locale), {
    day: "numeric",
    month: "long",
    timeZone: config.TZ,
  }).format(date);
  const deep = rowNumber(sleep, "deep_sleep_min");
  const light = rowNumber(sleep, "light_sleep_min");
  const rem = rowNumber(sleep, "rem_sleep_min");
  const bar = (value: number) => {
    const total = Math.max(1, sleepTotal(sleep));
    const blocks = Math.round((value / total) * 12);
    return `${"█".repeat(blocks)}${"░".repeat(Math.max(0, 12 - blocks))}`;
  };
  const hrText =
    hr && rowNumber(hr, "count")
      ? t(locale, "sleep.average", {
          avg: rowNumber(hr, "avg_value").toFixed(0),
          min: rowNumber(hr, "min_value").toFixed(0),
          max: rowNumber(hr, "max_value").toFixed(0),
        })
      : t(locale, "common.na");
  const spo2Text =
    spo2 && rowNumber(spo2, "count")
      ? t(locale, "sleep.minimum", {
          avg: rowNumber(spo2, "avg_value").toFixed(0),
          min: rowNumber(spo2, "min_value").toFixed(0),
        })
      : t(locale, "common.na");
  return [
    t(locale, "sleep.night", { date: esc(dateLabel) }),
    "",
    `${t(locale, "sleep.duration")}    <b>${minutes(sleepTotal(sleep), locale)}</b>`,
    `${t(locale, "sleep.quality")}        <b>${rowNumber(sleep, "sleep_score") || t(locale, "common.na")}${rowNumber(sleep, "sleep_score") ? " / 100" : ""}</b>`,
    `${t(locale, "sleep.bed")}         <b>${epoch(start, false, locale, config.TZ)} — ${epoch(end, false, locale, config.TZ)}</b>`,
    `${t(locale, "sleep.resting-heart-rate")}     <b>${rest && rowNumber(rest, "min_hr") ? `${rowNumber(rest, "min_hr")} bpm` : t(locale, "common.na")}</b>`,
    "",
    `${t(locale, "sleep.deep")}  <code>${bar(deep)}</code>  ${minutes(deep, locale)}`,
    `${t(locale, "sleep.light")}    <code>${bar(light)}</code>  ${minutes(light, locale)}`,
    ...(rem ? [`REM       <code>${bar(rem)}</code>  ${minutes(rem, locale)}`] : []),
    "",
    `${t(locale, "sleep.in-sleep")}   ${hrText}`,
    `${t(locale, "sleep.in-sleep-spo2")}  ${spo2Text}`,
  ].join("\n");
}

function dayText(config: AppConfig, uid: number, day: string): string {
  const locale = localeOf(config, uid);
  const data = daySummary(config, uid, day);
  const steps = data.steps as Record<string, unknown> | null;
  const sleep = data.sleep as Record<string, unknown> | null;
  const hr = data.hr as Record<string, unknown> | null;
  const spo2 = data.spo2 as Record<string, unknown> | null;
  const stress = data.stress as Record<string, unknown> | null;
  const calories = data.calories as Record<string, unknown> | null;
  const weight = data.weight as Record<string, unknown> | null;
  const workouts = (data.workouts as Record<string, unknown>[]) ?? [];
  const dayLabel = relativeDay(day, locale, config.TZ);
  const lines = [t(locale, "day.details", { day: esc(day), label: esc(dayLabel) }), ""];
  if (steps)
    lines.push(
      `${t(locale, "day.steps")} ${rowNumber(steps, "total_steps").toLocaleString(numberLocale(locale))} · ${(rowNumber(steps, "distance_m") / 1000).toFixed(1)} ${t(locale, "common.km")}`,
    );
  else lines.push(t(locale, "day.no-steps"));
  if (calories) {
    lines.push(
      t(locale, "day.activity", {
        hours: rowNumber(calories, "valid_stand_hours"),
        minutes: rowNumber(calories, "intensity_minutes"),
      }),
    );
    lines.push(
      t(locale, "day.energy", {
        total: rowNumber(calories, "total_cal").toFixed(0),
        active:
          calories.active_cal === null || calories.active_cal === undefined
            ? t(locale, "common.na")
            : rowNumber(calories, "active_cal").toFixed(0),
      }),
    );
  } else if (steps) lines.push(t(locale, "day.energy-simple", { calories: rowNumber(steps, "calories").toFixed(0) }));
  lines.push("");
  if (sleep)
    lines.push(
      `${t(locale, "day.sleep", { total: minutes(sleepTotal(sleep), locale), deep: minutes(rowNumber(sleep, "deep_sleep_min"), locale), light: minutes(rowNumber(sleep, "light_sleep_min"), locale) })}${rowNumber(sleep, "sleep_score") ? ` · ${rowNumber(sleep, "sleep_score")}/100` : ""} · ${epoch(rowNumber(sleep, "start_time"), false, locale, config.TZ)}→${epoch(rowNumber(sleep, "end_time"), false, locale, config.TZ)}`,
    );
  else lines.push(t(locale, "day.no-sleep"));
  lines.push("");
  if (hr && rowNumber(hr, "count"))
    lines.push(
      t(locale, "day.heart-rate", {
        avg: rowNumber(hr, "avg_value").toFixed(0),
        min: rowNumber(hr, "min_value").toFixed(0),
        max: rowNumber(hr, "max_value").toFixed(0),
      }),
    );
  else lines.push(t(locale, "day.no-heart-rate"));
  if (spo2 && rowNumber(spo2, "count"))
    lines.push(
      t(locale, "day.oxygen", {
        avg: rowNumber(spo2, "avg_value").toFixed(0),
        min: rowNumber(spo2, "min_value").toFixed(0),
        max: rowNumber(spo2, "max_value").toFixed(0),
      }),
    );
  else lines.push(t(locale, "day.no-oxygen"));
  if (stress && rowNumber(stress, "count"))
    lines.push(
      t(locale, "day.stress", {
        avg: rowNumber(stress, "avg_value").toFixed(0),
        min: rowNumber(stress, "min_value").toFixed(0),
        max: rowNumber(stress, "max_value").toFixed(0),
      }),
    );
  else lines.push(t(locale, "day.no-stress"));
  if (weight)
    lines.push(
      `${t(locale, "day.weight", { weight: rowNumber(weight, "weight_kg").toFixed(1) })}${rowNumber(weight, "bmi") ? ` · BMI: ${rowNumber(weight, "bmi").toFixed(1)}` : ""}`,
    );
  if (workouts.length) {
    lines.push("", t(locale, "day.training"));
    for (const workout of workouts)
      lines.push(
        `• <b>${esc(workoutType(rowString(workout, "sport_type"), locale))}</b> ${epoch(rowNumber(workout, "start_time"), false, locale, config.TZ)} (${Math.floor(rowNumber(workout, "duration_sec") / 60)}:${String(Math.floor(rowNumber(workout, "duration_sec") % 60)).padStart(2, "0")} · 🔥 ${rowNumber(workout, "calories").toFixed(0)} ${t(locale, "common.kcal")})`,
      );
  }
  return lines.join("\n");
}

function historyText(config: AppConfig, uid: number, days = 7): string {
  const locale = localeOf(config, uid);
  const end = localDay(config.TZ);
  const start = localDay(config.TZ, -(days - 1));
  const steps = dbRows(config, uid, "SELECT date,total_steps FROM steps_daily WHERE date BETWEEN ? AND ?", [
    start,
    end,
  ]);
  const sleep = dbRows(
    config,
    uid,
    "SELECT date,light_sleep_min,deep_sleep_min,COALESCE(total_duration_min,0) total_duration_min FROM sleep_daily WHERE date BETWEEN ? AND ?",
    [start, end],
  );
  const sleepByDay = new Map(sleep.map((row) => [rowString(row, "date"), row]));
  const allDays = [
    ...new Set([...steps.map((row) => rowString(row, "date")), ...sleep.map((row) => rowString(row, "date"))]),
  ]
    .sort()
    .reverse();
  if (!allDays.length) return `${t(locale, "history.title", { days })}\n\n${t(locale, "history.empty")}`;
  return [
    t(locale, "history.title", { days }),
    "",
    ...allDays.map((day) => {
      const step = steps.find((row) => rowString(row, "date") === day) ?? null;
      const sleepRow = sleepByDay.get(day) ?? null;
      const date = new Date(`${day}T12:00:00Z`);
      const label = new Intl.DateTimeFormat(numberLocale(locale), {
        day: "2-digit",
        month: "2-digit",
        timeZone: config.TZ,
      }).format(date);
      return `${dayEmoji(step, sleepRow)} <b>${label}</b>   ${step ? `${rowNumber(step, "total_steps").toLocaleString(numberLocale(locale))} ${t(locale, "history.steps")}` : t(locale, "history.no-steps")} · ${sleepRow ? minutes(sleepTotal(sleepRow), locale) : t(locale, "history.no-sleep")}`;
    }),
    "",
    t(locale, "history.hint"),
  ].join("\n");
}

function weeklyText(config: AppConfig, uid: number): string {
  const locale = localeOf(config, uid);
  const summary = periodSummary(config, uid, 7);
  const steps = summary.steps as Record<string, unknown>[];
  const sleep = summary.sleep as Record<string, unknown>[];
  const averages = (values: number[]) =>
    values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  const avgSteps = averages(steps.map((row) => rowNumber(row, "total_steps")));
  const avgSleep = averages(sleep.map((row) => sleepTotal(row)));
  const avgBed = formatBedtime(averageBedtime(sleep, config.TZ), locale);
  const previousStart = localDay(config.TZ, -13);
  const previousEnd = localDay(config.TZ, -7);
  const previousSteps = dbRows(config, uid, "SELECT total_steps FROM steps_daily WHERE date BETWEEN ? AND ?", [
    previousStart,
    previousEnd,
  ]).map((row) => rowNumber(row, "total_steps"));
  const previousSleep = dbRows(config, uid, "SELECT total_duration_min FROM sleep_daily WHERE date BETWEEN ? AND ?", [
    previousStart,
    previousEnd,
  ]).map((row) => rowNumber(row, "total_duration_min"));
  const diff = (current: number, previous: number, suffix: string) =>
    previous
      ? ` (${current - previous >= 0 ? "+" : ""}${current - previous}${suffix} ${current >= previous ? "📈" : "📉"})`
      : "";
  const recordSteps = steps.length
    ? steps.reduce(
        (best, row) => (rowNumber(row, "total_steps") > rowNumber(best, "total_steps") ? row : best),
        steps[0] as Record<string, unknown>,
      )
    : undefined;
  const recordSleep = sleep.length
    ? sleep.reduce(
        (best, row) => (sleepTotal(row) > sleepTotal(best) ? row : best),
        sleep[0] as Record<string, unknown>,
      )
    : undefined;
  return [
    t(locale, "weekly.title", { start: String(summary.start), end: String(summary.end) }),
    "",
    t(locale, "weekly.steps", {
      value: `${avgSteps.toLocaleString(numberLocale(locale))}${diff(avgSteps, averages(previousSteps), "")}`,
    }),
    t(locale, "weekly.sleep", {
      value: `${avgSleep ? minutes(avgSleep, locale) : t(locale, "common.na")}${diff(avgSleep, averages(previousSleep), ` ${t(locale, "common.minutes")}`)}`,
    }),
    t(locale, "weekly.bedtime", { value: avgBed }),
    "",
    t(locale, "weekly.records", {
      steps: recordSteps
        ? `${rowNumber(recordSteps, "total_steps")} (${formatWeekday(rowString(recordSteps, "date"), locale, config.TZ)})`
        : t(locale, "common.na"),
      sleep: recordSleep
        ? `${minutes(sleepTotal(recordSleep), locale)} (${formatWeekday(rowString(recordSleep, "date"), locale, config.TZ)})`
        : t(locale, "common.na"),
    }),
  ].join("\n");
}

function trendsText(config: AppConfig, uid: number, days: number): string {
  const locale = localeOf(config, uid);
  const summary = periodSummary(config, uid, days >= 3650 ? 3650 : days);
  const steps = summary.steps as Record<string, unknown>[];
  const sleep = summary.sleep as Record<string, unknown>[];
  const totalSteps = steps.reduce((sum, row) => sum + rowNumber(row, "total_steps"), 0);
  const avgSteps = steps.length ? Math.round(totalSteps / steps.length) : 0;
  const sleepValues = sleep.map(sleepTotal);
  const avgSleep = sleepValues.length ? Math.round(sleepValues.reduce((a, b) => a + b, 0) / sleepValues.length) : 0;
  const best = steps.reduce(
    (bestRow, row) => (rowNumber(row, "total_steps") > rowNumber(bestRow, "total_steps") ? row : bestRow),
    steps[0],
  );
  const hr = summary.hr as Record<string, unknown> | null;
  const spo2 = summary.spo2 as Record<string, unknown> | null;
  const stress = summary.stress as Record<string, unknown> | null;
  const calories = summary.calories as Record<string, unknown>[];
  const weight = (summary.weight as Record<string, unknown>[])[0];
  const period = days >= 3650 ? t(locale, "common.all-time") : `${days} ${t(locale, "common.days")}`;
  const lines = [
    t(locale, "trends.title", { period, start: String(summary.start), end: String(summary.end) }),
    "",
    t(locale, "trends.total-steps", { value: totalSteps.toLocaleString(numberLocale(locale)) }),
    t(locale, "trends.average-steps", { value: avgSteps.toLocaleString(numberLocale(locale)) }),
    t(locale, "trends.goal", {
      done: steps.filter((row) => rowNumber(row, "total_steps") >= STEP_GOAL).length,
      total: steps.length,
    }),
  ];
  if (best)
    lines.push(
      t(locale, "trends.best", {
        date: rowString(best, "date"),
        steps: rowNumber(best, "total_steps").toLocaleString(numberLocale(locale)),
      }),
    );
  if (calories.length)
    lines.push(
      "",
      t(locale, "trends.activity"),
      t(locale, "trends.energy", {
        value: Math.round(calories.reduce((sum, row) => sum + rowNumber(row, "total_cal"), 0) / calories.length),
      }),
    );
  lines.push(
    "",
    t(locale, "trends.average-sleep", { value: avgSleep ? minutes(avgSleep, locale) : t(locale, "common.na") }),
    t(locale, "trends.average-heart-rate", {
      value:
        hr && rowNumber(hr, "count")
          ? `${rowNumber(hr, "avg_value").toFixed(0)} bpm · ${rowNumber(hr, "min_value").toFixed(0)}–${rowNumber(hr, "max_value").toFixed(0)}`
          : t(locale, "common.na"),
    }),
    t(locale, "trends.average-oxygen", {
      value:
        spo2 && rowNumber(spo2, "count")
          ? `${rowNumber(spo2, "avg_value").toFixed(1)}% · min. ${rowNumber(spo2, "min_value").toFixed(0)}%`
          : t(locale, "common.na"),
    }),
    t(locale, "trends.average-stress", {
      value:
        stress && rowNumber(stress, "count")
          ? `${rowNumber(stress, "avg_value").toFixed(0)} · ${rowNumber(stress, "min_value").toFixed(0)}–${rowNumber(stress, "max_value").toFixed(0)}`
          : t(locale, "common.na"),
    }),
  );
  if (weight) lines.push(t(locale, "trends.latest-weight", { value: rowNumber(weight, "weight_kg").toFixed(1) }));
  return lines.concat(["", `<i>${t(locale, "common.health-care")}</i>`]).join("\n");
}

function familyText(config: AppConfig, uid: number): string {
  const locale = localeOf(config, uid);
  if (config.allowedUserIds.length < 2)
    return `👪 <b>${t(locale, "family.title")}</b>\n\n${t(locale, "family.need-two")}`;
  const [first, second] = config.allowedUserIds;
  if (first === undefined || second === undefined) return t(locale, "family.no-data");
  const stats = (uid: number) => {
    const start = localDay(config.TZ, -6);
    const end = localDay(config.TZ);
    const steps = dbRows(config, uid, "SELECT total_steps,distance_m FROM steps_daily WHERE date BETWEEN ? AND ?", [
      start,
      end,
    ]);
    const sleep = dbRows(
      config,
      uid,
      "SELECT total_duration_min,start_time FROM sleep_daily WHERE date BETWEEN ? AND ?",
      [start, end],
    );
    return {
      avgSteps: steps.length
        ? Math.round(steps.reduce((sum, row) => sum + rowNumber(row, "total_steps"), 0) / steps.length)
        : 0,
      totalSteps: steps.reduce((sum, row) => sum + rowNumber(row, "total_steps"), 0),
      distance: steps.reduce((sum, row) => sum + rowNumber(row, "distance_m"), 0),
      avgSleep: sleep.length
        ? Math.round(sleep.reduce((sum, row) => sum + rowNumber(row, "total_duration_min"), 0) / sleep.length)
        : 0,
      bedtime: averageBedtime(sleep, config.TZ),
    };
  };
  const a = stats(first);
  const b = stats(second);
  const nameA = USER_NAMES[first] ?? `User ${first}`;
  const nameB = USER_NAMES[second] ?? `User ${second}`;
  const winner = (left: number, right: number, leftName: string, rightName: string, suffix: string) =>
    left > right
      ? `${leftName} 🏆 (${left}${suffix} vs ${right}${suffix})`
      : right > left
        ? `${rightName} 🏆 (${right}${suffix} vs ${left}${suffix})`
        : `${t(locale, "versus.tie")} (${left}${suffix})`;
  const totalKm = (a.distance + b.distance) / 1000;
  const route =
    totalKm < 10
      ? t(locale, "common.family-route.park")
      : totalKm < 30
        ? t(locale, "common.family-route.mytishchi")
        : totalKm < 60
          ? t(locale, "common.family-route.podolsk")
          : totalKm < 100
            ? t(locale, "common.family-route.sergiev")
            : t(locale, "common.family-route.kolomna");
  return [
    `👪 <b>${t(locale, "family.title")}</b>`,
    "",
    t(locale, "family.steps-cup", {
      value: winner(a.avgSteps, b.avgSteps, nameA, nameB, ` ${t(locale, "common.day")}`),
    }),
    t(locale, "family.sleep-cup", {
      value: winner(a.avgSleep, b.avgSleep, nameA, nameB, ` ${t(locale, "common.minutes")}`),
    }),
    "",
    t(locale, "family.goal"),
    t(locale, "family.distance", {
      steps: (a.totalSteps + b.totalSteps).toLocaleString(numberLocale(locale)),
      distance: totalKm.toFixed(1),
      route,
    }),
  ].join("\n");
}

function versusText(config: AppConfig, uid: number, days: number): string {
  const locale = localeOf(config, uid);
  if (config.allowedUserIds.length < 2) return `📊 <b>Versus</b>\n\n${t(locale, "family.need-two")}`;
  const [first, second] = config.allowedUserIds;
  if (first === undefined || second === undefined) return t(locale, "versus.no-data");
  const names = [USER_NAMES[first] ?? `User ${first}`, USER_NAMES[second] ?? `User ${second}`];
  const data = (uid: number) => {
    const end = localDay(config.TZ);
    const start = localDay(config.TZ, -(days - 1));
    const steps = dbRows(config, uid, "SELECT total_steps FROM steps_daily WHERE date BETWEEN ? AND ?", [
      start,
      end,
    ]).map((row) => rowNumber(row, "total_steps"));
    const sleep = dbRows(
      config,
      uid,
      "SELECT total_duration_min,start_time FROM sleep_daily WHERE date BETWEEN ? AND ?",
      [start, end],
    );
    return {
      steps: steps.length ? Math.round(steps.reduce((a, b) => a + b, 0) / steps.length) : 0,
      sleep: sleep.length
        ? Math.round(sleep.reduce((sum, row) => sum + rowNumber(row, "total_duration_min"), 0) / sleep.length)
        : 0,
      bedtime: averageBedtime(sleep, config.TZ),
    };
  };
  const a = data(first);
  const b = data(second);
  const stepWinner =
    a.steps > b.steps
      ? t(locale, "versus.ahead", { name: names[0] ?? "" })
      : b.steps > a.steps
        ? t(locale, "versus.ahead", { name: names[1] ?? "" })
        : t(locale, "versus.tie");
  const sleepWinner =
    a.sleep > b.sleep
      ? t(locale, "versus.slept-longer", { name: names[0] ?? "" })
      : b.sleep > a.sleep
        ? t(locale, "versus.slept-longer", { name: names[1] ?? "" })
        : t(locale, "versus.tie");
  const bedtimeWinner =
    a.bedtime !== null && b.bedtime !== null
      ? a.bedtime < b.bedtime
        ? t(locale, "versus.fell-earlier", { name: names[0] ?? "" })
        : b.bedtime < a.bedtime
          ? t(locale, "versus.fell-earlier", { name: names[1] ?? "" })
          : t(locale, "versus.same-time")
      : "";
  return [
    t(locale, "versus.title", {
      first: names[0] ?? "",
      second: names[1] ?? "",
      period: days === 1 ? t(locale, "common.today") : t(locale, "menu.weekly"),
    }),
    "",
    t(locale, "versus.steps"),
    t(locale, "versus.steps-line", { name: names[0] ?? "", value: a.steps }),
    `${t(locale, "versus.steps-line", { name: names[1] ?? "", value: b.steps })} ${stepWinner}`,
    "",
    t(locale, "versus.sleep"),
    t(locale, "versus.sleep-line", {
      name: names[0] ?? "",
      value: a.sleep ? minutes(a.sleep, locale) : t(locale, "common.na"),
    }),
    `${t(locale, "versus.sleep-line", { name: names[1] ?? "", value: b.sleep ? minutes(b.sleep, locale) : t(locale, "common.na") })} ${sleepWinner}`,
    "",
    t(locale, "versus.bedtime"),
    `• ${names[0]}: ${formatBedtime(a.bedtime, locale)}`,
    `• ${names[1]}: ${formatBedtime(b.bedtime, locale)} ${bedtimeWinner}`,
  ].join("\n");
}

function keyboard(rows: Array<Array<[string, string]>>): InlineKeyboard {
  const result = new InlineKeyboard();
  rows.forEach((row, rowIndex) => {
    row.forEach(([text, data], index) => {
      if (index > 0) result.text(text, data);
      else result.text(text, data);
    });
    if (rowIndex < rows.length - 1) result.row();
  });
  return result;
}

function mainKb(locale: Locale): InlineKeyboard {
  return keyboard([
    [
      [t(locale, "menu.sleep"), "menu:sleep"],
      [t(locale, "menu.weekly"), "menu:trends"],
    ],
    [
      [t(locale, "menu.history"), "menu:history"],
      [t(locale, "menu.settings"), "menu:more"],
    ],
  ]);
}

function backKb(locale: Locale, to = "menu:main"): InlineKeyboard {
  return keyboard([[[t(locale, "menu.back"), to]]]);
}
function moreText(config: AppConfig, uid: number): string {
  const locale = localeOf(config, uid);
  const status = readStatus(config, uid);
  const tables = [
    "steps_daily",
    "sleep_daily",
    "sleep_stages",
    "heart_rate",
    "blood_oxygen",
    "stress",
    "calories_daily",
    "weight",
    "workouts",
  ];
  const records = tables.reduce(
    (total, table) => total + rowNumber(dbRows(config, uid, `SELECT COUNT(*) AS count FROM ${table}`)[0], "count"),
    0,
  );
  return [
    `⚙️ <b>${t(locale, "menu.service")}</b>`,
    "",
    t(locale, "service.device"),
    t(locale, "service.last-sync", { value: esc(String(status.last_sync_time ?? t(locale, "common.na"))) }),
    t(locale, "service.interval", { value: Math.floor(config.SYNC_INTERVAL / 60) }),
    t(locale, "service.records", { value: records.toLocaleString(numberLocale(locale)) }),
  ].join("\n");
}

function moreKb(locale: Locale): InlineKeyboard {
  return keyboard([
    [
      [t(locale, "menu.sync"), "menu:sync"],
      [t(locale, "menu.export"), "menu:export"],
    ],
    [
      [t(locale, "menu.db-status"), "menu:db_status"],
      [t(locale, "menu.workouts"), "menu:workouts"],
    ],
    [[t(locale, "menu.family"), "menu:family:more"]],
    [[t(locale, "menu.language"), "menu:language"]],
    [[t(locale, "menu.home"), "menu:main"]],
  ]);
}
function trendsKb(days: number, locale: Locale): InlineKeyboard {
  const daysLabel = (value: number) => `${value} ${t(locale, "common.days")}`;
  return keyboard([
    [
      [days === 7 ? `· ${daysLabel(7)} ·` : daysLabel(7), "period:7d"],
      [days === 30 ? `· ${daysLabel(30)} ·` : daysLabel(30), "period:30d"],
    ],
    [
      [days >= 3650 ? `· ${t(locale, "common.all-time")} ·` : t(locale, "common.all-time"), "period:all"],
      [t(locale, "menu.family"), "menu:family:trends"],
    ],
    [[t(locale, "menu.home"), "menu:main"]],
  ]);
}

function versusKb(locale: Locale): InlineKeyboard {
  return keyboard([
    [
      [t(locale, "common.today"), "versus:1"],
      [t(locale, "menu.weekly"), "versus:7"],
    ],
    [[t(locale, "menu.home"), "menu:main"]],
  ]);
}

function weeklyBackKb(locale: Locale): InlineKeyboard {
  return keyboard([[[t(locale, "menu.family"), "menu:family:weekly"]]]);
}
function historyKb(config: AppConfig, uid: number, days = 7, locale = localeOf(config, uid)): InlineKeyboard {
  const buttons: Array<Array<[string, string]>> = [
    [
      [days === 7 ? `· 7 ${t(locale, "common.days")} ·` : `7 ${t(locale, "common.days")}`, "period_cal:7"],
      [days === 30 ? `· 30 ${t(locale, "common.days")} ·` : `30 ${t(locale, "common.days")}`, "period_cal:30"],
    ],
  ];
  const dates = availableDays(config, uid, days);
  for (let index = 0; index < dates.length; index += 3)
    buttons.push(
      dates.slice(index, index + 3).map(
        (day) =>
          [
            new Intl.DateTimeFormat(numberLocale(locale), {
              day: "numeric",
              month: "short",
              timeZone: config.TZ,
            }).format(new Date(`${day}T12:00:00Z`)),
            `day:${day}`,
          ] as [string, string],
      ),
    );
  buttons.push([[t(locale, "menu.home"), "menu:main"]]);
  return keyboard(buttons);
}

function dayKb(day: string, locale: Locale, timeZone: string): InlineKeyboard {
  const previous = new Date(`${day}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  const nextDay = iso(next);
  return keyboard([
    [
      [`◀️ ${iso(previous)}`, `day:${iso(previous)}`],
      [
        nextDay > localDay(timeZone) ? t(locale, "menu.home") : `${nextDay} ▶️`,
        nextDay > localDay(timeZone) ? "menu:main" : `day:${nextDay}`,
      ],
    ],
    [[t(locale, "menu.calendar"), "menu:history"]],
  ]);
}

function languageKb(locale: Locale): InlineKeyboard {
  return keyboard([
    ...LOCALES.map((target) => [
      [target === locale ? `· ${LOCALE_NAMES[target]} ·` : LOCALE_NAMES[target], `locale:${target}`] as [
        string,
        string,
      ],
    ]),
    [[t(locale, "menu.back"), "menu:more"]],
  ]);
}

async function showMenu(
  context: BotContext,
  config: AppConfig,
  text: string,
  replyMarkup: InlineKeyboard | undefined,
  forceNew = false,
): Promise<void> {
  const uid = uidOf(context);
  const chatId = context.chat?.id;
  if (uid === null || chatId === undefined) return;
  const stored = getUserMenuMessageId(config, uid);
  const messageId = context.callbackQuery?.message?.message_id;
  if (!forceNew && (messageId ?? stored)) {
    try {
      await context.api.editMessageText(chatId, messageId ?? stored ?? 0, text, {
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      setUserMenuMessageId(config, uid, messageId ?? stored ?? 0);
      return;
    } catch (error) {
      log("debug", "Menu edit failed, sending a new message", { error });
    }
  }
  const sent = await context.reply(text, { parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  setUserMenuMessageId(config, uid, sent.message_id);
}

async function deleteIncoming(context: BotContext): Promise<void> {
  if (context.msg)
    await context.api.deleteMessage(context.chat?.id ?? 0, context.msg.message_id).catch(() => undefined);
}

function hasToken(config: AppConfig, uid: number): boolean {
  return existsSync(tokenPath(config, uid));
}
function onboardingText(locale: Locale): string {
  return `${t(locale, "auth.title")}\n\n${t(locale, "auth.first-run")}`;
}
function onboardingKb(locale: Locale): InlineKeyboard {
  return keyboard([[[t(locale, "auth.open-login"), "auth:start"]]]);
}

function externalUrl(value: string): string {
  return value.startsWith("//") ? `https:${value}` : value;
}

async function startLogin(context: BotContext, config: AppConfig, force = false): Promise<void> {
  const uid = uidOf(context);
  if (uid === null) return;
  const locale = localeOf(config, uid);
  if (hasToken(config, uid) && !force) {
    await showMenu(context, config, mainMenuText(config, uid), mainKb(locale));
    return;
  }
  await showMenu(context, config, `${t(locale, "auth.title")}\n\n${t(locale, "auth.prepare")}`, undefined);
  const auth = new XiaomiAuth();
  try {
    const token = await auth.loginQr(async (qr, login) => {
      const qrKeyboard = new InlineKeyboard();
      if (login) qrKeyboard.url(t(locale, "auth.open-login"), externalUrl(login));
      if (qr) qrKeyboard.row().url(t(locale, "auth.open-qr"), externalUrl(qr));
      await showMenu(
        context,
        config,
        `${t(locale, "auth.title")}\n\n${t(locale, "auth.open")}`,
        login || qr ? qrKeyboard : keyboard([[[t(locale, "auth.retry"), "auth:start"]]]),
      );
    });
    saveAuthToken(tokenPath(config, uid), token);
    const initial = { ...config, QUERY_DURATION: 30 };
    await showMenu(context, config, `✅ ${t(locale, "auth.title")}\n\n${t(locale, "auth.confirmed")}`, undefined);
    const result = await runSync(uid, initial);
    await showMenu(
      context,
      config,
      result.success
        ? mainMenuText(config, uid)
        : t(locale, "sync.failed", { error: esc(result.error ?? t(locale, "common.no-data")) }),
      result.success ? mainKb(locale) : backKb(locale, "menu:more"),
    );
  } catch (error) {
    await showMenu(
      context,
      config,
      `${t(locale, "auth.title")}\n\n${t(locale, "auth.failed", { error: esc(error) })}`,
      keyboard([
        [
          [t(locale, "auth.relogin"), "auth:relogin"],
          [t(locale, "menu.service"), "menu:more"],
        ],
      ]),
    );
  }
}

async function manualSync(context: BotContext, config: AppConfig): Promise<void> {
  const uid = uidOf(context);
  if (uid === null) return;
  const locale = localeOf(config, uid);
  if (!hasToken(config, uid)) {
    await showMenu(context, config, onboardingText(locale), onboardingKb(locale));
    return;
  }
  await showMenu(
    context,
    config,
    `${t(locale, "sync.title")}\n\n${t(locale, "sync.running")}`,
    backKb(locale, "menu:more"),
  );
  const result = await runSync(uid, config);
  const text = result.success
    ? t(locale, "sync.done")
    : t(locale, "sync.failed", { error: esc(result.error ?? t(locale, "common.no-data")) });
  await showMenu(context, config, text, result.success ? mainKb(locale) : backKb(locale, "menu:more"));
}

export function createBot(config: AppConfig): Bot<BotContext> {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN, { client: { apiRoot: config.TELEGRAM_API_ROOT } });
  bot.use(async (context, next) => {
    if (allowed(context, config)) await next();
  });
  bot.command("start", async (context) => {
    await deleteIncoming(context);
    const uid = uidOf(context);
    if (uid === null) return;
    const locale = localeOf(config, uid);
    if (!hasToken(config, uid)) await showMenu(context, config, onboardingText(locale), onboardingKb(locale), true);
    else await showMenu(context, config, mainMenuText(config, uid), mainKb(locale), true);
  });
  bot.command("status", async (context) => {
    await deleteIncoming(context);
    const uid = uidOf(context);
    if (uid !== null)
      await showMenu(context, config, statusText(config, uid), backKb(localeOf(config, uid), "menu:more"));
  });
  bot.command("sync", async (context) => {
    await deleteIncoming(context);
    await manualSync(context, config);
  });
  bot.command("versus", async (context) => {
    const uid = uidOf(context);
    if (uid === null) return;
    const locale = localeOf(config, uid);
    await showMenu(context, config, t(locale, "versus.choose"), versusKb(locale), true);
  });
  bot.on("message:text", async (context) => {
    const text = context.message.text;
    if (text.startsWith("/")) return;
    const uid = uidOf(context);
    if (uid === null) return;
    const locale = localeOf(config, uid);
    await deleteIncoming(context);
    if (!hasToken(config, uid)) return showMenu(context, config, onboardingText(locale), onboardingKb(locale));
    if (text.includes("Сон") || text.includes("Sleep") || text.includes("Sueño"))
      return showMenu(context, config, sleepText(config, uid), backKb(locale));
    if (text.includes("неделю") || text.includes("Weekly") || text.includes("Semanal"))
      return showMenu(context, config, trendsText(config, uid, 7), trendsKb(7, locale));
    if (text.includes("История") || text.includes("History") || text.includes("Historial"))
      return showMenu(context, config, historyText(config, uid, 7), historyKb(config, uid, 7, locale));
    if (text.includes("Настройки") || text.includes("Settings") || text.includes("Ajustes"))
      return showMenu(context, config, moreText(config, uid), moreKb(locale));
    return showMenu(context, config, mainMenuText(config, uid), mainKb(locale));
  });
  bot.on("callback_query:data", async (context) => {
    await context.answerCallbackQuery();
    const uid = uidOf(context);
    if (uid === null) return;
    const locale = localeOf(config, uid);
    const data = context.callbackQuery.data;
    if (data === "auth:start" || data === "auth:relogin") return startLogin(context, config, data === "auth:relogin");
    if (!hasToken(config, uid) && !data.startsWith("menu:main"))
      return showMenu(context, config, onboardingText(locale), onboardingKb(locale));
    if (data === "menu:main") return showMenu(context, config, mainMenuText(config, uid), mainKb(locale));
    if (data === "menu:sleep") return showMenu(context, config, sleepText(config, uid), backKb(locale));
    if (data === "menu:trends") return showMenu(context, config, trendsText(config, uid, 7), trendsKb(7, locale));
    if (data.startsWith("period:")) {
      const days = data === "period:all" ? 3650 : data === "period:30d" ? 30 : 7;
      return showMenu(context, config, trendsText(config, uid, days), trendsKb(days, locale));
    }
    if (data === "menu:history")
      return showMenu(context, config, historyText(config, uid, 7), historyKb(config, uid, 7, locale));
    if (data.startsWith("history:"))
      return showMenu(
        context,
        config,
        historyText(config, uid, Number(data.split(":")[1])),
        historyKb(config, uid, Number(data.split(":")[1]), locale),
      );
    if (data.startsWith("period_cal:")) {
      const days = Number(data.split(":")[1]) === 30 ? 30 : 7;
      return showMenu(context, config, historyText(config, uid, days), historyKb(config, uid, days, locale));
    }
    if (data.startsWith("day:")) {
      const day = data.slice("day:".length);
      return showMenu(context, config, dayText(config, uid, day), dayKb(day, locale, config.TZ));
    }
    if (data === "menu:more") return showMenu(context, config, moreText(config, uid), moreKb(locale));
    if (data === "menu:language")
      return showMenu(
        context,
        config,
        `${t(locale, "language.title")}\n\n${t(locale, "language.selected", { language: LOCALE_NAMES[locale] })}`,
        languageKb(locale),
      );
    if (data.startsWith("locale:")) {
      const target = data.slice("locale:".length);
      if (isLocale(target)) {
        setUserLocale(config, uid, target);
        return showMenu(
          context,
          config,
          t(target, "language.title") +
            "\n\n" +
            t(target, "language.updated") +
            "\n\n" +
            t(target, "language.selected", { language: LOCALE_NAMES[target] }),
          languageKb(target),
        );
      }
    }
    if (data === "menu:sync") return manualSync(context, config);
    if (data === "menu:db_status")
      return showMenu(context, config, statusText(config, uid), backKb(locale, "menu:more"));
    if (data === "menu:workouts")
      return showMenu(context, config, workoutsText(config, uid), backKb(locale, "menu:more"));
    if (data.startsWith("menu:family")) {
      const source = data.split(":")[2];
      return showMenu(
        context,
        config,
        familyText(config, uid),
        backKb(locale, source === "weekly" ? "menu:weekly_back" : "menu:trends"),
      );
    }
    if (data === "menu:weekly_back") return showMenu(context, config, weeklyText(config, uid), weeklyBackKb(locale));
    if (data === "menu:versus") return showMenu(context, config, t(locale, "versus.choose"), versusKb(locale));
    if (data.startsWith("versus:"))
      return showMenu(context, config, versusText(config, uid, Number(data.split(":")[1])), versusKb(locale));
    if (data === "menu:export") {
      await showMenu(context, config, t(locale, "export.running"), undefined);
      const archive = await zipExport(config, uid);
      if (archive && context.chat)
        await context.api.sendDocument(context.chat.id, new InputFile(archive, `miband-health-${Date.now()}.zip`), {
          caption: t(locale, "export.caption"),
        });
      return showMenu(
        context,
        config,
        archive ? t(locale, "export.sent") : t(locale, "export.empty"),
        backKb(locale, "menu:more"),
      );
    }
    return showMenu(context, config, mainMenuText(config, uid), mainKb(locale));
  });
  bot.catch((error) =>
    log("error", "Unhandled Telegram error", { error: error.error, update: error.ctx.update.update_id }),
  );
  return bot;
}

export async function configureBot(bot: Bot<BotContext>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Open menu" },
    { command: "sync", description: "Synchronize data" },
    { command: "status", description: "Database status" },
    { command: "versus", description: "Compare activity" },
  ]);
}

export function startBotTasks(bot: Bot<BotContext>, config: AppConfig): TaskHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWeeklyDate = "";
  const seenStatus = new Map<number, number>();
  const run = async (): Promise<void> => {
    if (stopped) return;
    const now = zonedDateParts(Date.now(), config.TZ);
    const weeklyDate = `${now.year}-${now.month}-${now.day}`;
    if (now.weekday === "Sun" && Number(now.hour) === 21 && Number(now.minute) === 0 && lastWeeklyDate !== weeklyDate) {
      lastWeeklyDate = weeklyDate;
      for (const uid of config.allowedUserIds) {
        try {
          const locale = localeOf(config, uid);
          await bot.api.sendMessage(uid, weeklyText(config, uid), {
            parse_mode: "HTML",
            reply_markup: keyboard([[[t(locale, "menu.family"), "menu:family:weekly"]]]),
          });
        } catch (error) {
          log("warn", "Weekly push failed", { userId: uid, error });
        }
      }
    }
    for (const uid of config.allowedUserIds) {
      const menuMessageId = getUserMenuMessageId(config, uid);
      if (!menuMessageId) continue;
      try {
        const modified = statSync(canonicalUserStatusPath(config, uid)).mtimeMs;
        if (modified <= (seenStatus.get(uid) ?? 0)) continue;
        await bot.api.editMessageText(uid, menuMessageId, mainMenuText(config, uid), {
          parse_mode: "HTML",
          reply_markup: mainKb(localeOf(config, uid)),
        });
        seenStatus.set(uid, modified);
      } catch (error) {
        log("debug", "Automatic menu refresh skipped", { userId: uid, error });
      }
    }
    if (!stopped) timer = setTimeout(() => void run(), Math.max(5, config.AUTO_MENU_REFRESH_INTERVAL) * 1000);
  };
  void run();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export type { SyncResult };
