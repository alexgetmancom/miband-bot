import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const booleanText = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const timeZoneText = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "must be a valid IANA timezone");

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseUserIds(raw: string | undefined): number[] {
  if (!raw?.trim()) return [];
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const ids = values.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ConfigurationError("TELEGRAM_ALLOWED_USER_IDS must contain positive integer IDs separated by commas");
  }
  return ids;
}

function readLocalSecrets(): Record<string, string> {
  const path = "secrets.env";
  if (!existsSync(path)) return {};
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().min(1).default("miband-bot"),
  BOT_MODE: z.enum(["polling", "webhook", "http-only"]).default("polling"),
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
  TELEGRAM_WEBHOOK_SECRET: optionalText,
  PUBLIC_WEBHOOK_URL: optionalText,
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  TELEGRAM_ALLOWED_USER_ID: z.string().optional(),
  ALLOWED_USERS: z.string().optional(),
  DATA_DIR: z.string().min(1).default("./data"),
  DB_PATH: z.string().min(1).optional(),
  STATUS_PATH: z.string().min(1).optional(),
  BOT_STATE_DB_PATH: z.string().min(1).optional(),
  SYNC_INTERVAL: z.coerce.number().int().min(0).default(900),
  QUERY_DURATION: z.coerce.number().int().min(1).default(2),
  ENABLE_FDS_SLEEP_DETAILS: booleanText.default(true),
  AUTO_MENU_REFRESH_INTERVAL: z.coerce.number().positive().default(30),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  TZ: timeZoneText.default("Europe/Moscow"),
});

export type AppConfig = z.infer<typeof envSchema> & {
  allowedUserIds: number[];
  dataDir: string;
  dbPath: string;
  statusPath: string;
  botStateDbPath: string;
};

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse({ ...readLocalSecrets(), ...source });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`Invalid environment configuration — ${details}`);
  }
  const value = parsed.data;
  const dataDir = resolve(value.DATA_DIR);
  const rawAllowed = value.TELEGRAM_ALLOWED_USER_IDS ?? value.TELEGRAM_ALLOWED_USER_ID ?? value.ALLOWED_USERS;
  let allowedUserIds = parseUserIds(rawAllowed);
  if (allowedUserIds.length === 0) {
    const path = join(dataDir, "allowed_user.id");
    if (existsSync(path)) {
      try {
        allowedUserIds = parseUserIds(readFileSync(path, "utf8"));
      } catch {
        allowedUserIds = [];
      }
    }
  }
  if (value.BOT_MODE !== "http-only" && !value.TELEGRAM_BOT_TOKEN) {
    throw new ConfigurationError("TELEGRAM_BOT_TOKEN is required unless BOT_MODE is http-only");
  }
  if (value.BOT_MODE === "webhook" && (!value.TELEGRAM_WEBHOOK_SECRET || !value.PUBLIC_WEBHOOK_URL)) {
    throw new ConfigurationError("TELEGRAM_WEBHOOK_SECRET and PUBLIC_WEBHOOK_URL are required in webhook mode");
  }
  return {
    ...value,
    allowedUserIds,
    dataDir,
    dbPath: resolve(value.DB_PATH ?? join(dataDir, "miband.db")),
    statusPath: resolve(value.STATUS_PATH ?? join(dataDir, "status.json")),
    botStateDbPath: resolve(value.BOT_STATE_DB_PATH ?? join(dataDir, "fitness_bot_state.db")),
  };
}

export function userId(config: AppConfig, candidate?: number): number {
  const resolved = candidate ?? config.allowedUserIds[0];
  if (resolved === undefined) throw new ConfigurationError("No Telegram user is configured");
  return resolved;
}

export function tokenPath(config: AppConfig, candidate?: number): string {
  const uid = userId(config, candidate);
  const preferred = join(config.dataDir, `token_${uid}.json`);
  const legacy = join(config.dataDir, "token.json");
  return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
}

export function userDbPath(config: AppConfig, candidate?: number): string {
  const uid = userId(config, candidate);
  const preferred = join(config.dataDir, `miband_${uid}.db`);
  return existsSync(preferred) ? preferred : config.dbPath;
}

export function canonicalUserDbPath(config: AppConfig, candidate?: number): string {
  return join(config.dataDir, `miband_${userId(config, candidate)}.db`);
}

export function userStatusPath(config: AppConfig, candidate?: number): string {
  const uid = userId(config, candidate);
  const preferred = join(config.dataDir, `status_${uid}.json`);
  return existsSync(preferred) ? preferred : config.statusPath;
}

export function canonicalUserStatusPath(config: AppConfig, candidate?: number): string {
  return join(config.dataDir, `status_${userId(config, candidate)}.json`);
}
