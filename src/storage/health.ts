import type { Database, SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../bot/i18n.js";
import { type AppConfig, userDbPath, userStatusPath } from "../config.js";
import { type OpenDatabase, openDatabase } from "./kv.js";

export const EXPORT_TABLES = [
  "steps_daily",
  "sleep_daily",
  "sleep_stages",
  "heart_rate",
  "blood_oxygen",
  "stress",
  "calories_daily",
  "weight",
  "workouts",
] as const;

export type Row = Record<string, unknown>;

export function initHealthDb(path: string): void {
  const database = openDatabase(path);
  database.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS steps_daily (
      date TEXT PRIMARY KEY, total_steps INTEGER, calories REAL, distance_m REAL, last_sync INTEGER
    );
    CREATE TABLE IF NOT EXISTS steps_detail (
      timestamp INTEGER PRIMARY KEY, steps INTEGER, calories REAL, distance_m REAL, activity_type TEXT
    );
    CREATE TABLE IF NOT EXISTS sleep_daily (
      date TEXT PRIMARY KEY, light_sleep_min INTEGER, deep_sleep_min INTEGER, start_time INTEGER, end_time INTEGER,
      rem_sleep_min INTEGER DEFAULT 0, awake_min INTEGER DEFAULT 0, total_duration_min INTEGER DEFAULT 0,
      sleep_score INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sleep_stages (
      start_time INTEGER PRIMARY KEY, stop_time INTEGER, stage TEXT, duration_min INTEGER
    );
    CREATE TABLE IF NOT EXISTS heart_rate (timestamp INTEGER PRIMARY KEY, value INTEGER);
    CREATE TABLE IF NOT EXISTS stress (timestamp INTEGER PRIMARY KEY, value INTEGER);
    CREATE TABLE IF NOT EXISTS blood_oxygen (timestamp INTEGER PRIMARY KEY, spo2 REAL, type TEXT);
    CREATE TABLE IF NOT EXISTS calories_daily (
      date TEXT PRIMARY KEY, total_cal REAL, active_cal REAL, valid_stand_hours INTEGER,
      intensity_minutes INTEGER, last_sync INTEGER
    );
    CREATE TABLE IF NOT EXISTS weight (timestamp INTEGER PRIMARY KEY, weight_kg REAL, bmi REAL, body_fat_pct REAL);
    CREATE TABLE IF NOT EXISTS workouts (
      workout_id TEXT PRIMARY KEY, sport_type TEXT, start_time INTEGER, end_time INTEGER, duration_sec INTEGER,
      calories REAL, avg_hr INTEGER, max_hr INTEGER, min_hr INTEGER, watermark INTEGER, raw_json TEXT
    );
  `);
  const columns = new Set(
    database.sqlite
      .query<{ name: string }, []>("PRAGMA table_info(sleep_daily)")
      .all()
      .map((row) => row.name),
  );
  for (const [name, definition] of [
    ["rem_sleep_min", "INTEGER DEFAULT 0"],
    ["awake_min", "INTEGER DEFAULT 0"],
    ["total_duration_min", "INTEGER DEFAULT 0"],
    ["sleep_score", "INTEGER DEFAULT 0"],
  ] as const) {
    if (!columns.has(name)) database.sqlite.run(`ALTER TABLE sleep_daily ADD COLUMN ${name} ${definition}`);
  }
  database.close();
}

export function initStateDb(path: string): void {
  const database = openDatabase(path);
  database.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_menu (
      user_id INTEGER PRIMARY KEY, menu_message_id INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_locale (
      user_id INTEGER PRIMARY KEY, locale TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  database.close();
}

export function getUserLocale(config: AppConfig, uid: number): Locale {
  try {
    const database = openDatabase(config.botStateDbPath);
    const row = database.sqlite
      .query<{ locale: string }, [number]>("SELECT locale FROM user_locale WHERE user_id = ?")
      .get(uid);
    database.close();
    return isLocale(row?.locale) ? row.locale : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setUserLocale(config: AppConfig, uid: number, locale: Locale): void {
  const database = openDatabase(config.botStateDbPath);
  database.sqlite
    .query(
      "INSERT INTO user_locale (user_id, locale, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET locale = excluded.locale, updated_at = excluded.updated_at",
    )
    .run(uid, locale, new Date().toISOString());
  database.close();
}

export function healthDbExists(config: AppConfig, uid: number): boolean {
  return existsSync(userDbPath(config, uid));
}

export function openHealthDb(config: AppConfig, uid: number): OpenDatabase {
  const path = userDbPath(config, uid);
  mkdirSync(dirname(path), { recursive: true });
  return openDatabase(path);
}

export function fetchOne(config: AppConfig, uid: number, query: string, params: SQLQueryBindings[] = []): Row | null {
  if (!healthDbExists(config, uid)) return null;
  const database = openHealthDb(config, uid);
  try {
    return (database.sqlite.query<Row, SQLQueryBindings[]>(query).get(...params) as Row | null) ?? null;
  } finally {
    database.close();
  }
}

export function fetchAll(config: AppConfig, uid: number, query: string, params: SQLQueryBindings[] = []): Row[] {
  if (!healthDbExists(config, uid)) return [];
  const database = openHealthDb(config, uid);
  try {
    return database.sqlite.query<Row, SQLQueryBindings[]>(query).all(...params) as Row[];
  } finally {
    database.close();
  }
}

export function withHealthDb<T>(config: AppConfig, uid: number, action: (database: Database) => T): T {
  const database = openHealthDb(config, uid);
  try {
    return action(database.sqlite);
  } finally {
    database.close();
  }
}

export function getUserMenuMessageId(config: AppConfig, uid: number): number | null {
  try {
    const database = openDatabase(config.botStateDbPath);
    const row = database.sqlite
      .query<{ menu_message_id: number }, [number]>("SELECT menu_message_id FROM user_menu WHERE user_id = ?")
      .get(uid);
    database.close();
    return row?.menu_message_id ?? null;
  } catch {
    return null;
  }
}

export function setUserMenuMessageId(config: AppConfig, uid: number, messageId: number): void {
  const database = openDatabase(config.botStateDbPath);
  database.sqlite
    .query("INSERT OR REPLACE INTO user_menu (user_id, menu_message_id, updated_at) VALUES (?, ?, ?)")
    .run(uid, messageId, new Date().toISOString());
  database.close();
}

export function readStatus(config: AppConfig, uid: number): Row {
  try {
    return JSON.parse(readFileSync(userStatusPath(config, uid), "utf8")) as Row;
  } catch {
    return {};
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function zipExport(config: AppConfig, uid: number): Promise<Uint8Array | null> {
  if (!healthDbExists(config, uid)) return null;
  const files: Record<string, string> = {};
  withHealthDb(config, uid, (sqlite) => {
    for (const table of EXPORT_TABLES) {
      const exists = sqlite
        .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) continue;
      const query = sqlite.query<Row, []>(`SELECT * FROM ${table} ORDER BY 1`);
      const rows = query.all() as Row[];
      if (!rows.length) continue;
      const headers = Object.keys(rows[0] ?? {});
      const lines = [headers.map(csvCell).join(",")];
      for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
      files[`${table}.csv`] = `${lines.join("\n")}\n`;
    }
  });
  if (Object.keys(files).length === 0) return null;
  return await new Bun.Archive(files).bytes();
}

export function ensureUserDataDir(config: AppConfig): void {
  mkdirSync(join(config.dataDir), { recursive: true });
}
