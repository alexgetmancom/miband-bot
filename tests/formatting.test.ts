import { describe, expect, test } from "bun:test";
import { epoch, esc, minutes, stepBar } from "../src/bot/formatting.js";

describe("bot formatting", () => {
  test("escapes Telegram HTML and formats health values", () => {
    expect(esc('<secret> & "value"')).toBe("&lt;secret&gt; &amp; &quot;value&quot;");
    expect(minutes(396)).toBe("6 h 36 min");
    expect(stepBar(5000)).toContain("50%");
  });

  test("formats timestamps in the configured timezone", () => {
    const timestamp = Date.parse("2026-08-12T00:00:00Z") / 1000;
    expect(epoch(timestamp, false, "en", "UTC")).toContain("00:00");
    expect(epoch(timestamp, false, "en", "Europe/Moscow")).toContain("03:00");
  });
});
