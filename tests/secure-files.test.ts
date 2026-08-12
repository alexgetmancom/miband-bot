import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});
