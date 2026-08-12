import { describe, expect, test } from "bun:test";
import { esc, minutes, stepBar } from "../src/bot/formatting.js";

describe("bot formatting", () => {
  test("escapes Telegram HTML and formats health values", () => {
    expect(esc('<secret> & "value"')).toBe("&lt;secret&gt; &amp; &quot;value&quot;");
    expect(minutes(396)).toBe("6 h 36 min");
    expect(stepBar(5000)).toContain("50%");
  });
});
