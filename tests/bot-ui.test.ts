import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBot } from "../src/bot/app.js";
import type { Locale } from "../src/bot/i18n.js";
import { type AppConfig, loadConfig } from "../src/config.js";
import { initHealthDb, initStateDb, setUserLocale, withHealthDb } from "../src/storage/health.js";

type ApiCall = { method: string; payload: Record<string, unknown> };
type KeyboardButton = { text: string; callback_data?: string };

function callbackUpdate(data: string): Parameters<ReturnType<typeof createBot>["handleUpdate"]>[0] {
  return {
    update_id: Date.now(),
    callback_query: {
      id: `query-${Date.now()}`,
      data,
      from: { id: 42, is_bot: false, first_name: "Test" },
      chat_instance: "test",
      message: {
        message_id: 99,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private", first_name: "Test" },
        text: "menu",
      },
    },
  };
}

function configFor(dir: string): AppConfig {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_ALLOWED_USER_IDS: "42,43",
    DATA_DIR: dir,
  });
}

async function runCallback(
  data: string,
  language: Locale = "en",
  seed?: (config: AppConfig) => void,
): Promise<ApiCall[]> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "miband-ui-"));
  try {
    const config = configFor(dir);
    writeFileSync(join(dir, "token_42.json"), "{}");
    initStateDb(config.botStateDbPath);
    setUserLocale(config, 42, language);
    initHealthDb(join(dir, "miband_42.db"));
    initHealthDb(join(dir, "miband_43.db"));
    seed?.(config);
    const calls: ApiCall[] = [];
    const bot = createBot(config);
    bot.botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot" } as never;
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method: String(method), payload: payload as Record<string, unknown> });
      return { ok: true, result: true } as never;
    });
    await bot.handleUpdate(callbackUpdate(data));
    return calls;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function editCall(calls: ApiCall[]): ApiCall {
  const call = calls.find((item) => item.method === "editMessageText");
  if (!call) throw new Error("editMessageText call was not made");
  return call;
}

function rows(call: ApiCall): KeyboardButton[][] {
  const markup = call.payload.reply_markup as { inline_keyboard: KeyboardButton[][] };
  return markup.inline_keyboard;
}

function button(rowsToRead: KeyboardButton[][], text: string): KeyboardButton {
  const found = rowsToRead.flat().find((item) => item.text === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

describe("bot UI callback parity", () => {
  test("opens versus from its legacy menu callback", async () => {
    const call = editCall(await runCallback("menu:versus"));
    expect(call.payload.text).toBe("📊 <b>Compare activity:</b>");
    expect(button(rows(call), "Today").callback_data).toBe("versus:1");
    expect(button(rows(call), "📊 Weekly").callback_data).toBe("versus:7");
  });

  test("preserves the family return destination", async () => {
    const weekly = editCall(await runCallback("menu:family:weekly"));
    expect(button(rows(weekly), "⬅️ Back").callback_data).toBe("menu:weekly_back");

    const trends = editCall(await runCallback("menu:family:trends"));
    expect(button(rows(trends), "⬅️ Back").callback_data).toBe("menu:trends");

    const weeklyBack = editCall(await runCallback("menu:weekly_back"));
    expect(String(weeklyBack.payload.text)).toContain("📊 Weekly summary:");
    expect(button(rows(weeklyBack), "👪 Family").callback_data).toBe("menu:family:weekly");
  });

  test("marks the selected trends period", async () => {
    const call = editCall(await runCallback("period:30d"));
    expect(button(rows(call), "· 30 days ·").callback_data).toBe("period:30d");
    expect(button(rows(call), "All time").callback_data).toBe("period:all");
  });

  test("uses English as the default main keyboard", async () => {
    const call = editCall(await runCallback("menu:main"));
    expect(button(rows(call), "😴 Sleep").callback_data).toBe("menu:sleep");
    expect(button(rows(call), "📊 Weekly").callback_data).toBe("menu:trends");
    expect(button(rows(call), "⚙️ Settings").callback_data).toBe("menu:more");
  });

  test("offers Russian and Spanish in the language settings", async () => {
    const languageMenu = editCall(await runCallback("menu:language"));
    expect(button(rows(languageMenu), "Русский").callback_data).toBe("locale:ru");
    expect(button(rows(languageMenu), "Español").callback_data).toBe("locale:es");

    const spanish = editCall(await runCallback("locale:es"));
    expect(button(rows(spanish), "· Español ·").callback_data).toBe("locale:es");
    const spanishMain = editCall(await runCallback("menu:main", "es"));
    expect(button(rows(spanishMain), "😴 Sueño").callback_data).toBe("menu:sleep");
  });

  test("renders Spanish trend labels", async () => {
    const call = editCall(await runCallback("menu:trends", "es"));
    expect(String(call.payload.text)).toContain("📊 Tendencias");
    expect(button(rows(call), "30 días").callback_data).toBe("period:30d");
    expect(button(rows(call), "👪 Familia").callback_data).toBe("menu:family:trends");
  });

  test("does not append /100 to an unavailable sleep score", async () => {
    const call = editCall(
      await runCallback("menu:sleep", "ru", (config) => {
        withHealthDb(config, 42, (database) => {
          database
            .prepare(
              "INSERT INTO sleep_daily (date,light_sleep_min,deep_sleep_min,start_time,end_time,total_duration_min,sleep_score) VALUES (?,?,?,?,?,?,?)",
            )
            .run("2026-08-12", 120, 120, 1_755_000_000, 1_755_025_200, 240, 0);
        });
      }),
    );
    expect(String(call.payload.text)).toContain("Качество        <b>н/д</b>");
    expect(String(call.payload.text)).not.toContain("Качество        <b>н/д / 100</b>");
  });
});
