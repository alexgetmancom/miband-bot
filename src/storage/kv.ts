import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type OpenDatabase = { sqlite: Database; path: string; close: () => void };

export function openDatabase(url: string): OpenDatabase {
  const path = url === ":memory:" ? url : resolve(url);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA busy_timeout = 30000");
  if (path !== ":memory:") sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  return { sqlite, path, close: () => sqlite.close() };
}

export function migrateDatabase(database: OpenDatabase): void {
  database.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

export function getState(database: OpenDatabase, key: string): string | null {
  const row = database.sqlite.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setState(database: OpenDatabase, key: string, value: string): void {
  database.sqlite
    .query(
      "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, new Date().toISOString());
}
