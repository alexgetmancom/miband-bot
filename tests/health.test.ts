import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initHealthDb, zipExport } from "../src/storage/health.js";
import { openDatabase } from "../src/storage/kv.js";

function tempDir(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "miband-ts-"));
}

describe("health storage", () => {
  test("creates the health schema and exports CSV files as ZIP", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "miband_42.db");
    initHealthDb(dbPath);
    const database = openDatabase(dbPath);
    database.sqlite.query("INSERT INTO steps_daily (date,total_steps) VALUES (?,?)").run("2026-08-11", 1234);
    database.close();
    const config = {
      dataDir: dir,
      dbPath,
      statusPath: join(dir, "status.json"),
      botStateDbPath: join(dir, "state.db"),
      allowedUserIds: [42],
      BOT_MODE: "http-only",
      QUERY_DURATION: 2,
    } as never;
    const archive = await zipExport(config, 42);
    expect(archive).not.toBeNull();
    expect(new Uint8Array(archive ?? []).length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
