import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type AppConfig, canonicalUserDbPath, canonicalUserStatusPath, tokenPath, userId } from "./config.js";
import { log } from "./logger.js";
import { initHealthDb, withHealthDb } from "./storage/health.js";
import {
  type AuthToken,
  readToken,
  saveAuthToken,
  withExclusiveFileLock,
  writeJsonAtomic,
} from "./storage/secure-files.js";
import {
  type AggregatedDataItem,
  formatXiaomiError,
  MiHealthClient,
  type SleepData,
  type StepData,
  TokenExpiredError,
} from "./xiaomi/client.js";
import { downloadAndDecryptSleepDetails, parseAllDaySleepBytes } from "./xiaomi/fds.js";

export type SyncResult = { success: boolean; userId: number; counters: Record<string, number>; error?: string };

function increment(counters: Record<string, number>, key: string, amount = 1): void {
  counters[key] = (counters[key] ?? 0) + amount;
}

function timestamp(): number {
  return Math.floor(Date.now() / 1000);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatEpoch(value: number): string | null {
  return value ? new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19) : null;
}

function targetRelativeUid(token: AuthToken): number | null {
  const value = token.target_relative_uid ?? token.user_id;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function bootstrapToken(): AuthToken {
  return {
    user_id: process.env.USER_ID ?? "",
    c_user_id: process.env.C_USER_ID ?? "",
    service_token: process.env.SERVICE_TOKEN ?? "",
    ssecurity: process.env.SSECURITY ?? "",
    pass_token: process.env.PASS_TOKEN ?? "",
    device_id: process.env.DEVICE_ID ?? `an_${crypto.randomUUID().replaceAll("-", "")}`,
    ...(process.env.TARGET_RELATIVE_UID ? { target_relative_uid: process.env.TARGET_RELATIVE_UID } : {}),
  };
}

export async function runSync(candidateUserId: number | undefined, config: AppConfig): Promise<SyncResult> {
  const uid = userId(config, candidateUserId);
  const lockPath = `${config.dataDir}/sync_${uid}.lock`;
  try {
    return await withExclusiveFileLock(lockPath, () => runSyncLocked(uid, config));
  } catch (error) {
    const message =
      error instanceof Error && error.name === "LockUnavailable"
        ? "Sync is already running for this user"
        : formatXiaomiError(error);
    log("warn", message, { userId: uid });
    return { success: false, userId: uid, counters: {}, error: message };
  }
}

async function runSyncLocked(uid: number, config: AppConfig): Promise<SyncResult> {
  const path = tokenPath(config, uid);
  if (!existsSync(path) && uid === config.allowedUserIds[0] && process.env.SSECURITY) {
    saveAuthToken(path, bootstrapToken());
  }
  if (!existsSync(path))
    return { success: false, userId: uid, counters: {}, error: `Token file not found at: ${path}` };
  const token = (() => {
    try {
      return readToken(path);
    } catch {
      return null;
    }
  })();
  if (!token) return { success: false, userId: uid, counters: {}, error: `Token file cannot be read: ${path}` };
  const relativeUid = targetRelativeUid(token);
  if (!relativeUid)
    return { success: false, userId: uid, counters: {}, error: `No target_relative_uid or user_id found in ${path}` };
  const dbPath = canonicalUserDbPath(config, uid);
  const statusPath = canonicalUserStatusPath(config, uid);
  initHealthDb(dbPath);
  const counters: Record<string, number> = {};
  let latestSteps: StepData | undefined;
  let latestSleep: SleepData | undefined;
  let latestHeartRate: { timestamp: number; value: number } | undefined;
  const client = MiHealthClient.fromToken(path);
  try {
    const steps = await client.getSteps(relativeUid, config.QUERY_DURATION);
    withHealthDb(config, uid, (database) => {
      for (const item of steps) {
        const date = new Date(item.time * 1000).toISOString().slice(0, 10);
        database
          .query(
            "INSERT OR REPLACE INTO steps_daily (date,total_steps,calories,distance_m,last_sync) VALUES (?,?,?,?,?)",
          )
          .run(date, item.steps, item.calories, item.distance, timestamp());
        increment(counters, "steps_daily");
        if (!latestSteps || date >= new Date(latestSteps.time * 1000).toISOString().slice(0, 10)) latestSteps = item;
      }
    });

    const sleep = await client.getSleep(relativeUid, config.QUERY_DURATION);
    for (const item of sleep) {
      const date = new Date(item.time * 1000).toISOString().slice(0, 10);
      withHealthDb(config, uid, (database) => {
        const segments = item.segment_details;
        const start = segments.length ? Math.min(...segments.map((segment) => segment.bedtime)) : 0;
        const end = segments.length ? Math.max(...segments.map((segment) => segment.wake_up_time)) : 0;
        for (const segment of segments) {
          database
            .query("INSERT OR REPLACE INTO sleep_stages (start_time,stop_time,stage,duration_min) VALUES (?,?,?,?)")
            .run(segment.bedtime, segment.wake_up_time, "sleep_segment", segment.duration);
          increment(counters, "sleep_stages");
        }
        database
          .query(
            "INSERT OR REPLACE INTO sleep_daily (date,light_sleep_min,deep_sleep_min,rem_sleep_min,awake_min,total_duration_min,sleep_score,start_time,end_time) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            date,
            item.sleep_light_duration,
            item.sleep_deep_duration,
            item.sleep_rem_duration,
            item.sleep_awake_duration,
            item.total_duration,
            item.sleep_score,
            start,
            end,
          );
        increment(counters, "sleep_daily");
      });
      if (!latestSleep || item.time > latestSleep.time) latestSleep = item;
    }

    const heartRate = await client.getHeartRate(relativeUid, config.QUERY_DURATION);
    withHealthDb(config, uid, (database) => {
      for (const item of heartRate) {
        insertHeartRate(database, item.avg_hr, item.time, counters);
        if (item.latest_hr) {
          insertHeartRate(database, item.latest_hr.bpm, item.latest_hr.time, counters);
          if (!latestHeartRate || item.latest_hr.time > latestHeartRate.timestamp)
            latestHeartRate = { timestamp: item.latest_hr.time, value: item.latest_hr.bpm };
        }
      }
    });

    try {
      const spo2 = await client.getSpo2History(relativeUid, config.QUERY_DURATION);
      withHealthDb(config, uid, (database) => {
        for (const item of spo2) {
          insertBloodOxygen(database, item.avg_spo2, item.time, "daily_avg", counters);
          if (item.latest_spo2)
            insertBloodOxygen(database, item.latest_spo2.spo2, item.latest_spo2.time, "latest", counters);
        }
      });
    } catch (error) {
      log("warn", "Failed to fetch blood oxygen", { error });
    }

    await syncPointMetrics(client, relativeUid, config, uid, counters);
    await syncCalories(client, relativeUid, config, uid, counters);
    await syncWeight(client, relativeUid, config, uid, counters);
    await syncWorkouts(client, relativeUid, config, uid, counters);
    if (config.ENABLE_FDS_SLEEP_DETAILS) await syncFds(client, relativeUid, config, uid, sleep, counters);
    saveAuthToken(path, client.auth.token);
    writeStatus(statusPath, latestSteps, latestHeartRate, latestSleep);
    return { success: true, userId: uid, counters };
  } catch (error) {
    const message =
      error instanceof TokenExpiredError
        ? "Token has expired and auto-refresh failed. Action required: re-login."
        : `API request failed: ${formatXiaomiError(error)}`;
    log("error", message, { userId: uid });
    return { success: false, userId: uid, counters, error: message };
  }
}

function insertHeartRate(database: Database, value: number, time: number, counters: Record<string, number>): void {
  const result = database.query("INSERT OR IGNORE INTO heart_rate (timestamp,value) VALUES (?,?)").run(time, value);
  if (result.changes > 0) increment(counters, "heart_rate");
}

function insertBloodOxygen(
  database: Database,
  value: number,
  time: number,
  type: string,
  counters: Record<string, number>,
): void {
  const result = database
    .query("INSERT OR IGNORE INTO blood_oxygen (timestamp,spo2,type) VALUES (?,?,?)")
    .run(time, value, type);
  if (result.changes > 0) increment(counters, "blood_oxygen");
}

async function syncPointMetrics(
  client: MiHealthClient,
  relativeUid: number,
  config: AppConfig,
  uid: number,
  counters: Record<string, number>,
): Promise<void> {
  const start = Math.floor(Date.now() / 1000) - config.QUERY_DURATION * 86_400;
  const end = Math.floor(Date.now() / 1000);
  for (const [key, table, field] of [
    ["heart_rate", "heart_rate", "bpm"],
    ["spo2", "blood_oxygen", "spo2"],
    ["stress", "stress", "stress"],
  ] as const) {
    try {
      const items = await client.getFitnessData(relativeUid, key, start, end, 1440 * config.QUERY_DURATION);
      withHealthDb(config, uid, (database) => {
        for (const item of items) {
          const value = parseMetricValue(item, field);
          if (!value) continue;
          const query =
            table === "blood_oxygen"
              ? "INSERT OR IGNORE INTO blood_oxygen (timestamp,spo2,type) VALUES (?,?,?)"
              : `INSERT OR IGNORE INTO ${table} (timestamp,value) VALUES (?,?)`;
          const result =
            table === "blood_oxygen"
              ? database.query(query).run(item.time, value, "point")
              : database.query(query).run(item.time, value);
          if (result.changes > 0) increment(counters, table);
        }
      });
    } catch (error) {
      log("warn", `Failed to fetch ${key}`, { error });
    }
  }
}

function parseMetricValue(item: AggregatedDataItem, field: string): number {
  const raw = (() => {
    try {
      return JSON.parse(item.value) as unknown;
    } catch {
      return item.value;
    }
  })();
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return Number((raw as Record<string, unknown>)[field] ?? 0);
  return Number(raw);
}

async function syncCalories(
  client: MiHealthClient,
  relativeUid: number,
  config: AppConfig,
  uid: number,
  counters: Record<string, number>,
): Promise<void> {
  const start = Math.floor(Date.now() / 1000) - config.QUERY_DURATION * 86_400;
  const end = Math.floor(Date.now() / 1000);
  const values = new Map<string, Record<string, number>>();
  for (const [key, field, valueKey] of [
    ["calories", "total_cal", "calories"],
    ["intensity", "intensity_minutes", "duration"],
    ["valid_stand", "valid_stand_hours", "count"],
  ] as const) {
    try {
      for (const item of await client.getAggregatedData(relativeUid, key, start, end, config.QUERY_DURATION)) {
        const value = parseMetricValue(item, valueKey);
        if (!value) continue;
        const date = new Date(item.time * 1000).toISOString().slice(0, 10);
        const entry = values.get(date) ?? {};
        entry[field] = field === "total_cal" ? (entry[field] ?? 0) + value : Math.max(entry[field] ?? 0, value);
        values.set(date, entry);
      }
    } catch (error) {
      log("warn", `Failed to fetch ${key}`, { error });
    }
  }
  withHealthDb(config, uid, (database) => {
    for (const [date, value] of values) {
      const result = database
        .query(
          "INSERT OR REPLACE INTO calories_daily (date,total_cal,active_cal,valid_stand_hours,intensity_minutes,last_sync) VALUES (?,?,?,?,?,?)",
        )
        .run(
          date,
          value.total_cal ?? null,
          value.active_cal ?? null,
          value.valid_stand_hours ?? null,
          value.intensity_minutes ?? null,
          timestamp(),
        );
      if (result.changes > 0) increment(counters, "calories_daily");
    }
  });
}

async function syncWeight(
  client: MiHealthClient,
  relativeUid: number,
  config: AppConfig,
  uid: number,
  counters: Record<string, number>,
): Promise<void> {
  try {
    const values = await client.getWeightHistory(relativeUid, Math.max(config.QUERY_DURATION, 180));
    withHealthDb(config, uid, (database) => {
      for (const item of values) {
        if (!item.weight || item.weight <= 0) continue;
        const result = database
          .query("INSERT OR IGNORE INTO weight (timestamp,weight_kg,bmi) VALUES (?,?,?)")
          .run(item.time, item.weight, item.bmi);
        if (result.changes > 0) increment(counters, "weight");
      }
    });
  } catch (error) {
    log("warn", "Failed to fetch weight", { error });
  }
}

async function syncWorkouts(
  client: MiHealthClient,
  relativeUid: number,
  config: AppConfig,
  uid: number,
  counters: Record<string, number>,
): Promise<void> {
  try {
    let watermark = 0;
    let hasMore = true;
    while (hasMore) {
      const response = await client.request("GET", "/app/v1/data/get_sport_records_by_watermark", {
        relative_uid: relativeUid,
        watermark,
        limit: 50,
      });
      const result = record(response.result);
      const records = Array.isArray(result.sport_records) ? result.sport_records : [];
      hasMore = result.has_more === true;
      if (!records.length) break;
      withHealthDb(config, uid, (database) => {
        for (const rawRecord of records) {
          const entry = record(rawRecord);
          const value = (() => {
            const raw = entry.value;
            if (typeof raw === "string") {
              try {
                return record(JSON.parse(raw));
              } catch {
                return {};
              }
            }
            return record(raw);
          })();
          const recordWatermark = Number(entry.watermark ?? 0);
          watermark = Math.max(watermark, recordWatermark);
          const workoutId = String(entry.sid ?? entry.did ?? "");
          const start = Number(value.start_time ?? entry.time ?? 0);
          const duration = Number(value.duration ?? 0);
          const resultRow = database
            .query(
              "INSERT OR IGNORE INTO workouts (workout_id,sport_type,start_time,end_time,duration_sec,calories,avg_hr,max_hr,min_hr,watermark,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              workoutId,
              String(entry.key ?? entry.category ?? "unknown"),
              start,
              Number(value.end_time ?? start + duration),
              duration,
              Number(value.calories ?? value.total_cal ?? 0),
              Number(value.avg_hrm ?? 0),
              Number(value.max_hrm ?? 0),
              Number(value.min_hrm ?? 0),
              recordWatermark,
              JSON.stringify(value),
            );
          if (resultRow.changes > 0) increment(counters, "workouts");
        }
      });
    }
    log("debug", "Workout watermark sync completed", { userId: uid });
  } catch (error) {
    log("warn", "Failed to fetch workouts", { error });
  }
}

async function syncFds(
  client: MiHealthClient,
  relativeUid: number,
  config: AppConfig,
  uid: number,
  sleep: SleepData[],
  counters: Record<string, number>,
): Promise<void> {
  for (const item of sleep)
    for (const segment of item.segment_details) {
      try {
        const content = await downloadAndDecryptSleepDetails(
          client,
          relativeUid,
          segment.wake_up_time,
          segment.timezone,
          (message) => log("debug", message),
        );
        const parsed = content ? parseAllDaySleepBytes(content) : null;
        if (!parsed) continue;
        withHealthDb(config, uid, (database) => {
          for (const [timestampValue, value] of parsed.records.heart_rate) {
            database
              .query("INSERT OR REPLACE INTO heart_rate (timestamp,value) VALUES (?,?)")
              .run(timestampValue, value);
            increment(counters, "heart_rate");
          }
          for (const [timestampValue, value] of parsed.records.spo2) {
            database
              .query("INSERT OR REPLACE INTO blood_oxygen (timestamp,spo2,type) VALUES (?,?,?)")
              .run(timestampValue, value, "fds_detail");
            increment(counters, "blood_oxygen");
          }
        });
        increment(counters, "fds_segments");
      } catch (error) {
        log("debug", "FDS sleep detail unavailable", { error });
      }
    }
}

function writeStatus(
  path: string,
  steps: StepData | undefined,
  heartRate: { timestamp: number; value: number } | undefined,
  sleep: SleepData | undefined,
): void {
  writeJsonAtomic(path, {
    last_sync: timestamp(),
    last_sync_time: formatEpoch(timestamp()),
    today: steps
      ? {
          date: new Date(steps.time * 1000).toISOString().slice(0, 10),
          steps: steps.steps,
          calories: steps.calories,
          distance_m: steps.distance,
        }
      : null,
    latest_heart_rate: heartRate
      ? { timestamp: heartRate.timestamp, time: formatEpoch(heartRate.timestamp), value: heartRate.value }
      : null,
    latest_sleep: sleep
      ? {
          date: new Date(sleep.time * 1000).toISOString().slice(0, 10),
          light_sleep_min: sleep.sleep_light_duration,
          deep_sleep_min: sleep.sleep_deep_duration,
          rem_sleep_min: sleep.sleep_rem_duration,
          awake_min: sleep.sleep_awake_duration,
          total_sleep_min: sleep.total_duration || sleep.sleep_light_duration + sleep.sleep_deep_duration,
          sleep_score: sleep.sleep_score,
          start_time: formatEpoch(Math.min(...sleep.segment_details.map((segment) => segment.bedtime), 0)),
          end_time: formatEpoch(Math.max(...sleep.segment_details.map((segment) => segment.wake_up_time), 0)),
        }
      : null,
  });
}

export async function runSyncDaemon(config: AppConfig, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const current = (() => {
      try {
        return config.allowedUserIds;
      } catch {
        return [];
      }
    })();
    if (current.length === 0) {
      log("info", "Sync daemon is waiting for Telegram /start binding");
      await Bun.sleep(5000);
      continue;
    }
    for (const uid of current) await runSync(uid, config);
    if (config.SYNC_INTERVAL <= 0) return;
    await Bun.sleep(config.SYNC_INTERVAL * 1000);
  }
}
