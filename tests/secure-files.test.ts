import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withExclusiveFileLock } from "../src/storage/secure-files.js";

describe("file locks", () => {
  test("releases the lock directory after the action", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "miband-lock-"));
    const path = join(directory, "sync.lock");
    await withExclusiveFileLock(path, async () => "first");
    await expect(withExclusiveFileLock(path, async () => "second")).resolves.toBe("second");
    rmSync(directory, { recursive: true, force: true });
  });

  test("reclaims a lock whose owner process is gone", async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "miband-lock-stale-"));
    const path = join(directory, "sync.lock");
    mkdirSync(`${path}.d`);
    writeFileSync(join(`${path}.d`, "owner"), "pid=2147483647 time=0\n");
    await expect(withExclusiveFileLock(path, async () => "reclaimed")).resolves.toBe("reclaimed");
    rmSync(directory, { recursive: true, force: true });
  });
});
