import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SECRET_MODE = 0o600;

export function writeTextAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split("/").pop() ?? "file"}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: mode ?? 0o644 });
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
    if (mode !== undefined) chmodSync(path, mode);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already removed it.
    }
  }
}

export function writeJsonAtomic(path: string, data: unknown, mode?: number): void {
  writeTextAtomic(path, `${JSON.stringify(data, null, 2)}\n`, mode);
}

export function writeSecretJson(path: string, data: unknown): void {
  writeJsonAtomic(path, data, SECRET_MODE);
}

export type AuthToken = {
  user_id: string;
  c_user_id: string;
  service_token: string;
  ssecurity: string;
  pass_token: string;
  device_id: string;
  target_relative_uid?: string | number;
};

export function readToken(path: string): AuthToken {
  const payload = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthToken>;
  return {
    user_id: String(payload.user_id ?? ""),
    c_user_id: String(payload.c_user_id ?? ""),
    service_token: String(payload.service_token ?? ""),
    ssecurity: String(payload.ssecurity ?? ""),
    pass_token: String(payload.pass_token ?? ""),
    device_id: String(payload.device_id ?? ""),
    ...(payload.target_relative_uid === undefined ? {} : { target_relative_uid: payload.target_relative_uid }),
  };
}

export function saveAuthToken(path: string, token: AuthToken): void {
  let current: Partial<AuthToken> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthToken>;
  } catch {
    // New token.
  }
  const payload = { ...token };
  if (current.target_relative_uid !== undefined && payload.target_relative_uid === undefined) {
    payload.target_relative_uid = current.target_relative_uid;
  }
  writeSecretJson(path, payload);
}

export class LockUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockUnavailable";
  }
}

export async function withExclusiveFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockDir = `${path}.d`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch {
    let stale = false;
    try {
      const lockText = readFileSync(path, "utf8");
      const pid = Number(lockText.match(/pid=(\d+)/)?.[1] ?? 0);
      if (pid > 0) {
        try {
          process.kill(pid, 0);
        } catch {
          stale = true;
        }
      }
    } catch {
      stale = false;
    }
    if (!stale) throw new LockUnavailable(`Lock is already held: ${path}`);
    try {
      rmdirSync(lockDir);
      if (existsSync(path)) unlinkSync(path);
      mkdirSync(lockDir);
    } catch {
      throw new LockUnavailable(`Lock is already held: ${path}`);
    }
  }
  try {
    writeFileSync(path, `pid=${process.pid} time=${Math.floor(Date.now() / 1000)}\n`, "utf8");
    return await action();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Best effort cleanup.
    }
    try {
      rmdirSync(lockDir);
    } catch {
      // Best effort cleanup.
    }
  }
}
