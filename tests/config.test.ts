import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  test("keeps http-only mode usable without Telegram credentials", () => {
    const config = loadConfig({ BOT_MODE: "http-only", DATABASE_URL: ":memory:", QUERY_DURATION: "2" });
    expect(config.BOT_MODE).toBe("http-only");
    expect(config.QUERY_DURATION).toBe(2);
    expect(config.dataDir).toContain("data");
  });

  test("parses the personal allowlist", () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_USER_IDS: "42, 7" });
    expect(config.allowedUserIds).toEqual([42, 7]);
  });

  test("rejects malformed IDs and incomplete webhook settings", () => {
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_USER_IDS: "42,nope" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc", BOT_MODE: "webhook", TELEGRAM_ALLOWED_USER_IDS: "42" }),
    ).toThrow(ConfigurationError);
  });

  test("treats empty strings as unset", () => {
    expect(loadConfig({ BOT_MODE: "http-only", TELEGRAM_BOT_TOKEN: "" }).TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  test("parses textual booleans instead of coercing false to true", () => {
    const config = loadConfig({ BOT_MODE: "http-only", ENABLE_FDS_SLEEP_DETAILS: "false" });
    expect(config.ENABLE_FDS_SLEEP_DETAILS).toBe(false);
  });
});
