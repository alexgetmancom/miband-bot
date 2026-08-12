import { describe, expect, test } from "bun:test";
import { parseAllDaySleepBytes } from "../src/xiaomi/fds.js";

describe("FDS parser", () => {
  test("rejects truncated sleep payloads", () => {
    expect(parseAllDaySleepBytes(new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 0]))).toBeNull();
  });
});
