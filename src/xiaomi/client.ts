import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { log } from "../logger.js";
import { type AuthToken, readToken, saveAuthToken } from "../storage/secure-files.js";

export type { AuthToken } from "../storage/secure-files.js";

const API_BASE = "https://ru.hlth.io.mi.com";
const STS_URL = "https://sts-hlth.io.mi.com/healthapp/sts";
const QR_URL = "https://account.xiaomi.com/longPolling/loginUrl";
const SERVICE_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin";
const DEFAULT_UA = "Android-12-3.53.1-vivo-V2284A";
const LOGIN_UA =
  "Dalvik/2.1.0 (Linux; U; Android 12; V2284A Build/ab8c0d1.1) APP/mi.health APPV/353001 MK/VjIyODRB SDKV/5.3.0.release.68 CPN/com.mi.health PassportSDK/";
export const XIAOMI_REQUEST_TIMEOUT_MS = 30_000;

export class XiaomiError extends Error {}
export class TokenExpiredError extends XiaomiError {}
export class AuthError extends XiaomiError {}
export class APIError extends XiaomiError {
  constructor(
    message: string,
    readonly details: { statusCode?: number; code?: number; responseBody?: string } = {},
  ) {
    super(message);
    this.name = "APIError";
  }
}
export class DataNotSharedError extends XiaomiError {
  constructor(
    message: string,
    readonly dataType = "",
  ) {
    super(message);
    this.name = "DataNotSharedError";
  }
}
export class DataOutOfSharedTimeScopeError extends DataNotSharedError {}
export class FamilyMemberNotFoundError extends XiaomiError {}
export class DeviceUntrustedError extends AuthError {}
export class CaptchaRequiredError extends AuthError {
  constructor(
    message: string,
    readonly captchaUrl = "",
  ) {
    super(message);
    this.name = "CaptchaRequiredError";
  }
}

export type LatestHeartRate = { bpm: number; time: number };
export type SleepSegment = {
  bedtime: number;
  wake_up_time: number;
  duration: number;
  sleep_deep_duration: number;
  sleep_light_duration: number;
  timezone: number;
  awake_count?: number;
  sleep_awake_duration: number;
};
export type HeartRateData = {
  time: number;
  avg_hr: number;
  avg_rhr: number;
  max_hr: number;
  min_hr: number;
  latest_hr: LatestHeartRate | null;
  abnormal_hr_count?: number;
  aerobic_hr_zone_duration?: number;
  anaerobic_hr_zone_duration?: number;
  extreme_hr_zone_duration?: number;
  fat_burning_hr_zone_duration?: number;
  warm_up_hr_zone_duration?: number;
};
export type SleepData = {
  time: number;
  total_duration: number;
  sleep_score: number;
  sleep_deep_duration: number;
  sleep_light_duration: number;
  sleep_rem_duration: number;
  sleep_awake_duration: number;
  sleep_stage?: number;
  long_sleep_evaluation?: number;
  day_sleep_evaluation?: number;
  avg_hr?: number;
  max_hr?: number;
  min_hr?: number;
  avg_spo2?: number;
  segment_details: SleepSegment[];
};
export type StepData = { time: number; steps: number; distance: number; calories: number; goal?: number };
export type WeightData = { time: number; weight: number; bmi: number };
export type BloodPressureData = { time: number; systolic: number; diastolic: number; pulse: number | null };
export type GoalItem = { field: number; target_value: number; achieved_value: number };
export type GoalData = { time: number; goal_items: GoalItem[] };
export type CaloriesData = { time: number; calories: number; goal: number };
export type ValidStandData = { time: number; count: number };
export type IntensityData = { time: number; duration: number };
export type Spo2Data = { time: number; spo2: number };
export type Spo2SummaryData = {
  time: number;
  avg_spo2: number;
  max_spo2?: number;
  min_spo2?: number;
  lack_spo2_count?: number;
  latest_spo2: Spo2Data | null;
};
export type AggregatedDataItem = {
  sid: string;
  tag: string;
  key: string;
  time: number;
  value: string;
  update_time: number;
  watermark: string;
  source_sid_list?: string[];
};
export type FamilyMember = {
  relative_uid: number;
  relative_note: string;
  relative_icon?: string;
  latest_data_time: number;
  latest_abnormal_record_time?: number | null;
  source_tag?: number;
};
export type VerifiedUserInfo = { user_id: number; nickname: string; icon: string };
export type LatestDataItem = { time: number; key: string; value: string | number };
export type LatestDataSnapshot = {
  updated_time: number;
  goal: GoalData | null;
  heart_rate: LatestHeartRate | null;
  sleep: SleepData | null;
  blood_pressure: BloodPressureData | null;
  steps: StepData | null;
  calories: CaloriesData | null;
  valid_stand: ValidStandData | null;
  intensity: IntensityData | null;
  weight: WeightData | null;
  spo2: Spo2Data | null;
  extras: Record<string, unknown>;
};
export type DailySummary = {
  date: string;
  relative_uid: number;
  heart_rate: HeartRateData | null;
  sleep: SleepData | null;
  steps: StepData | null;
};
export type InviteMessage = {
  msg_id: number;
  module: number;
  type: number;
  receiver: number;
  sender: number;
  extra_data: string;
  is_new: number;
  data_status: number;
  create_time: number;
  last_modify: number;
  invite_id: number | null;
  nick_name: string;
  icon: string;
  is_pending: boolean;
};

type JsonObject = Record<string, unknown>;
type ApiResponse = { code?: unknown; message?: unknown; result?: unknown } & JsonObject;

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function bytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

function urlSafeBase64(value: Uint8Array): string {
  return base64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
}

function parseValue(value: unknown): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    return asObject(JSON.parse(value));
  } catch {
    return {};
  }
}

function rc4(key: Uint8Array, input: Uint8Array, skip = 1024): Uint8Array {
  if (!key.length) throw new XiaomiError("RC4 key is empty");
  const s = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (s[i] ?? 0) + (key[i % key.length] ?? 0)) & 255;
    [s[i], s[j]] = [s[j] ?? 0, s[i] ?? 0];
  }
  let i = 0;
  j = 0;
  const next = (): number => {
    i = (i + 1) & 255;
    j = (j + (s[i] ?? 0)) & 255;
    [s[i], s[j]] = [s[j] ?? 0, s[i] ?? 0];
    return s[((s[i] ?? 0) + (s[j] ?? 0)) & 255] ?? 0;
  };
  for (let n = 0; n < skip; n += 1) next();
  return Uint8Array.from(input, (value) => value ^ next());
}

export function rc4Crypt(key: Uint8Array, input: Uint8Array, skip = 1024): Uint8Array {
  return rc4(key, input, skip);
}

function signedNonce(ssecurity: string, nonce: string): string {
  const hash = createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
    .digest();
  return base64(hash);
}

export function computeSignedNonce(ssecurity: string, nonce: string): string {
  return signedNonce(ssecurity, nonce);
}

function sha1Base64(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("base64");
}

function signatureMessage(method: string, path: string, params: Record<string, string>, nonce: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return [
    method.toUpperCase(),
    normalized,
    ...Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`),
    nonce,
  ].join("&");
}

function encryptedParams(
  method: string,
  path: string,
  ssecurity: string,
  params: JsonObject | undefined,
): Record<string, string> {
  const nonce = base64(
    Buffer.concat([
      randomBytes(8),
      (() => {
        const result = Buffer.alloc(4);
        result.writeUInt32BE(Math.floor(Date.now() / 60_000), 0);
        return result;
      })(),
    ]),
  );
  const snonce = signedNonce(ssecurity, nonce);
  const raw: Record<string, string> = {};
  if (params) raw.data = JSON.stringify(params);
  const rc4Hash = sha1Base64(signatureMessage(method, path, raw, snonce));
  raw.rc4_hash__ = rc4Hash;
  const entries = Object.entries(raw).sort(([a], [b]) => a.localeCompare(b));
  const plaintext = Buffer.concat(entries.map(([, value]) => Buffer.from(value, "utf8")));
  const encrypted = rc4(bytes(snonce), plaintext);
  const output: Record<string, string> = {};
  let position = 0;
  for (const [key, value] of entries) {
    const length = Buffer.byteLength(value, "utf8");
    output[key] = base64(encrypted.slice(position, position + length));
    position += length;
  }
  output.signature = sha1Base64(signatureMessage(method, path, output, snonce));
  output._nonce = nonce;
  return output;
}

export function buildEncryptedParams(
  method: string,
  path: string,
  ssecurity: string,
  params?: JsonObject,
): Record<string, string> {
  return encryptedParams(method, path, ssecurity, params);
}

export function decryptResponse(ssecurity: string, nonce: string, ciphertext: string): unknown {
  const snonce = signedNonce(ssecurity, nonce);
  const plaintext = Buffer.from(rc4(bytes(snonce), bytes(ciphertext))).toString("utf8");
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

export function encryptData(snonce: string, plaintext: string): string {
  return base64(rc4(bytes(snonce), new TextEncoder().encode(plaintext)));
}

export function decryptData(snonce: string, ciphertext: string): string {
  return new TextDecoder().decode(rc4(bytes(snonce), bytes(ciphertext)));
}

function dataItem(item: unknown): AggregatedDataItem {
  const value = asObject(item);
  const raw = value.value;
  return {
    sid: stringValue(value.sid),
    tag: stringValue(value.tag),
    key: stringValue(value.key),
    time: numberValue(value.time),
    value: typeof raw === "string" ? raw : JSON.stringify(raw ?? {}),
    update_time: numberValue(value.update_time),
    watermark: stringValue(value.watermark),
    source_sid_list: Array.isArray(value.source_sid_list)
      ? value.source_sid_list.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function parseSegments(value: unknown): SleepSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const entry = asObject(item);
      return {
        bedtime: numberValue(entry.bedtime),
        wake_up_time: numberValue(entry.wake_up_time),
        duration: numberValue(entry.duration),
        sleep_deep_duration: numberValue(entry.sleep_deep_duration),
        sleep_light_duration: numberValue(entry.sleep_light_duration),
        timezone: numberValue(entry.timezone),
        awake_count: numberValue(entry.awake_count),
        sleep_awake_duration: numberValue(entry.sleep_awake_duration),
      };
    });
}

function parseAggregated(item: AggregatedDataItem, key: string): JsonObject {
  const value = parseValue(item.value);
  value.time = item.time;
  if (key === "sleep") value.segment_details = parseSegments(value.segment_details);
  return value;
}

function parseHeartRate(item: AggregatedDataItem): HeartRateData {
  const value = parseAggregated(item, "heart_rate");
  const latest = asObject(value.latest_hr);
  return {
    time: numberValue(value.time),
    avg_hr: numberValue(value.avg_hr),
    avg_rhr: numberValue(value.avg_rhr),
    max_hr: numberValue(value.max_hr),
    min_hr: numberValue(value.min_hr),
    latest_hr: Object.keys(latest).length ? { bpm: numberValue(latest.bpm), time: numberValue(latest.time) } : null,
    abnormal_hr_count: numberValue(value.abnormal_hr_count),
    aerobic_hr_zone_duration: numberValue(value.aerobic_hr_zone_duration),
    anaerobic_hr_zone_duration: numberValue(value.anaerobic_hr_zone_duration),
    extreme_hr_zone_duration: numberValue(value.extreme_hr_zone_duration),
    fat_burning_hr_zone_duration: numberValue(value.fat_burning_hr_zone_duration),
    warm_up_hr_zone_duration: numberValue(value.warm_up_hr_zone_duration),
  };
}

function parseSleep(item: AggregatedDataItem): SleepData {
  const value = parseAggregated(item, "sleep");
  return {
    time: numberValue(value.time),
    total_duration: numberValue(value.total_duration),
    sleep_score: numberValue(value.sleep_score),
    sleep_deep_duration: numberValue(value.sleep_deep_duration),
    sleep_light_duration: numberValue(value.sleep_light_duration),
    sleep_rem_duration: numberValue(value.sleep_rem_duration),
    sleep_awake_duration: numberValue(value.sleep_awake_duration),
    sleep_stage: numberValue(value.sleep_stage),
    long_sleep_evaluation: numberValue(value.long_sleep_evaluation),
    day_sleep_evaluation: numberValue(value.day_sleep_evaluation),
    avg_hr: numberValue(value.avg_hr),
    max_hr: numberValue(value.max_hr),
    min_hr: numberValue(value.min_hr),
    avg_spo2: numberValue(value.avg_spo2),
    segment_details: parseSegments(value.segment_details),
  };
}

function parseSteps(item: AggregatedDataItem): StepData {
  const value = parseAggregated(item, "steps");
  return {
    time: numberValue(value.time),
    steps: numberValue(value.steps),
    distance: numberValue(value.distance),
    calories: numberValue(value.calories),
    goal: numberValue(value.goal),
  };
}

function parseSpo2(item: AggregatedDataItem): Spo2SummaryData {
  const value = parseAggregated(item, "spo2");
  const latest = asObject(value.latest_spo2);
  return {
    time: numberValue(value.time),
    avg_spo2: numberValue(value.avg_spo2),
    max_spo2: numberValue(value.max_spo2),
    min_spo2: numberValue(value.min_spo2),
    lack_spo2_count: numberValue(value.lack_spo2_count),
    latest_spo2: Object.keys(latest).length ? { time: numberValue(latest.time), spo2: numberValue(latest.spo2) } : null,
  };
}

function parseWeight(item: AggregatedDataItem): WeightData {
  const value = parseAggregated(item, "weight");
  return { time: numberValue(value.time), weight: numberValue(value.weight), bmi: numberValue(value.bmi) };
}

function parseBloodPressure(item: AggregatedDataItem): BloodPressureData {
  const value = parseAggregated(item, "blood_pressure");
  return {
    time: numberValue(value.time),
    systolic: numberValue(value.systolic ?? value.systolic_pressure),
    diastolic: numberValue(value.diastolic ?? value.diastolic_pressure),
    pulse: value.pulse === undefined || value.pulse === null ? null : numberValue(value.pulse),
  };
}

function parseLatestValue(item: LatestDataItem): JsonObject {
  const value = typeof item.value === "string" ? parseValue(item.value) : asObject(item.value);
  value.time = item.time;
  return value;
}

function parseLatestItem(item: LatestDataItem): unknown {
  const value = parseLatestValue(item);
  switch (item.key) {
    case "goal":
      return {
        time: numberValue(value.time),
        goal_items: Array.isArray(value.goal_items)
          ? value.goal_items.map((entry) => {
              const goal = asObject(entry);
              return {
                field: numberValue(goal.field),
                target_value: numberValue(goal.target_value),
                achieved_value: numberValue(goal.achieved_value),
              };
            })
          : [],
      } satisfies GoalData;
    case "heart_rate":
      return { bpm: numberValue(value.bpm), time: numberValue(value.time) } satisfies LatestHeartRate;
    case "sleep":
      return {
        ...parseSleep({ ...dataItem({ key: item.key, time: item.time, value: JSON.stringify(value) }) }),
      } satisfies SleepData;
    case "steps":
      return {
        time: numberValue(value.time),
        steps: numberValue(value.steps),
        distance: numberValue(value.distance),
        calories: numberValue(value.calories),
        goal: numberValue(value.goal),
      } satisfies StepData;
    case "weight":
      return {
        time: numberValue(value.time),
        weight: numberValue(value.weight),
        bmi: numberValue(value.bmi),
      } satisfies WeightData;
    case "blood_pressure":
      return {
        time: numberValue(value.time),
        systolic: numberValue(value.systolic ?? value.systolic_pressure),
        diastolic: numberValue(value.diastolic ?? value.diastolic_pressure),
        pulse: value.pulse === undefined || value.pulse === null ? null : numberValue(value.pulse),
      } satisfies BloodPressureData;
    case "calories":
      return {
        time: numberValue(value.time),
        calories: numberValue(value.calories),
        goal: numberValue(value.goal),
      } satisfies CaloriesData;
    case "valid_stand":
      return { time: numberValue(value.time), count: numberValue(value.count) } satisfies ValidStandData;
    case "intensity":
      return { time: numberValue(value.time), duration: numberValue(value.duration) } satisfies IntensityData;
    case "spo2":
      return { time: numberValue(value.time), spo2: numberValue(value.spo2) } satisfies Spo2Data;
    default:
      return value;
  }
}

function parseLatestDataItems(value: unknown): LatestDataItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const entry = asObject(item);
      const raw = entry.value;
      return {
        time: numberValue(entry.time),
        key: stringValue(entry.key),
        value: typeof raw === "string" || typeof raw === "number" ? raw : JSON.stringify(raw ?? {}),
      };
    });
}

function latestSnapshot(items: LatestDataItem[], updatedTime: number): LatestDataSnapshot {
  const snapshot: LatestDataSnapshot = {
    updated_time: updatedTime,
    goal: null,
    heart_rate: null,
    sleep: null,
    blood_pressure: null,
    steps: null,
    calories: null,
    valid_stand: null,
    intensity: null,
    weight: null,
    spo2: null,
    extras: {},
  };
  for (const item of items) {
    const parsed = parseLatestItem(item);
    if (item.key in snapshot && item.key !== "updated_time" && item.key !== "extras") {
      (snapshot as unknown as Record<string, unknown>)[item.key] = parsed;
    } else {
      snapshot.extras[item.key] = parsed;
    }
  }
  return snapshot;
}

function windowArguments(queryDateOrDays: Date | number | undefined, days = 1): [Date, number] {
  if (typeof queryDateOrDays === "number") return [new Date(), Math.max(1, queryDateOrDays)];
  return [queryDateOrDays ?? new Date(), Math.max(1, days)];
}

function dateWindow(days: number, queryDate = new Date()): [number, number, number] {
  const endDate = new Date(
    Date.UTC(queryDate.getUTCFullYear(), queryDate.getUTCMonth(), queryDate.getUTCDate() + 1, 0, 0, 0),
  );
  const end = Math.floor(endDate.getTime() / 1000) - 1;
  const windowDays = Math.max(1, days);
  return [end - 86_400 * windowDays + 1, end, windowDays];
}

class XiaomiHttp {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly headers: Record<string, string>) {}

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(this.headers);
    for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), XIAOMI_REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const response = await fetch(url, { ...init, headers, redirect: "manual", signal });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(";", 1)[0] ?? "";
        const index = pair.indexOf("=");
        if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  get cookiesSnapshot(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }
}

function parseMiResponse(text: string): JsonObject {
  const body = text.startsWith("&&&START&&&") ? text.slice("&&&START&&&".length) : text;
  try {
    return asObject(JSON.parse(body));
  } catch {
    throw new XiaomiError(`Xiaomi response is not JSON: ${body.slice(0, 200)}`);
  }
}

export class XiaomiAuth {
  token: AuthToken;
  private tokenFilePath: string | undefined;
  private readonly http = new XiaomiHttp({
    "user-agent": LOGIN_UA,
    "content-type": "application/x-www-form-urlencoded",
  });

  constructor(
    token: AuthToken = {
      user_id: "",
      c_user_id: "",
      service_token: "",
      ssecurity: "",
      pass_token: "",
      device_id: `an_${randomBytes(16).toString("hex")}`,
    },
  ) {
    this.token = token;
  }

  static fromToken(path: string): XiaomiAuth {
    const auth = new XiaomiAuth(readToken(path));
    auth.tokenFilePath = path;
    return auth;
  }

  get isAuthenticated(): boolean {
    return Boolean(this.token.service_token && this.token.ssecurity);
  }

  get canRefresh(): boolean {
    return Boolean(this.token.pass_token && this.token.user_id);
  }

  saveToken(path = this.tokenFilePath): void {
    if (!path) throw new AuthError("Token path is not configured");
    saveAuthToken(path, this.token);
    this.tokenFilePath = path;
  }

  loadToken(path: string): AuthToken {
    this.token = readToken(path);
    this.tokenFilePath = path;
    return this.token;
  }

  async refresh(): Promise<AuthToken> {
    if (!this.canRefresh) throw new TokenExpiredError("Token cannot be refreshed without passToken and userId");
    await this.refreshWithPassToken();
    if (this.tokenFilePath) this.saveToken(this.tokenFilePath);
    return this.token;
  }

  toString(): string {
    return `XiaomiAuth(user=${this.token.user_id || "N/A"}, ${this.isAuthenticated ? "authenticated" : "unauthenticated"})`;
  }

  async loginQr(callback?: (qrImageUrl: string, loginUrl: string) => Promise<void>, maxWait = 300): Promise<AuthToken> {
    this.http.setCookie("deviceId", this.token.device_id);
    const query = new URLSearchParams({
      _qrsize: "480",
      qs: "%3Fsid%3Dmiothealth%26_json%3Dtrue",
      callback: STS_URL,
      _hasLogo: "false",
      sid: "miothealth",
      serviceParam: "",
      _locale: "zh_CN",
      _dc: String(Date.now()),
    });
    const qrResponse = await this.http.request(`${QR_URL}?${query}`);
    if (!qrResponse.ok) throw new XiaomiError(`QR request failed: ${qrResponse.status}`);
    const qr = parseMiResponse(await qrResponse.text());
    const image = stringValue(qr.qr);
    const loginUrl = stringValue(qr.loginUrl);
    const pollingUrl = stringValue(qr.lp);
    if (!image || !pollingUrl) throw new XiaomiError("Xiaomi did not return a QR polling URL");
    await callback?.(image, loginUrl);
    const timeout = Math.min(numberValue(qr.timeout, maxWait), maxWait) * 1000;
    const started = Date.now();
    let response: Response | undefined;
    while (Date.now() - started < timeout) {
      try {
        response = await this.http.request(pollingUrl);
        if (response.status === 200) break;
        await Bun.sleep(2000);
      } catch (error) {
        log("warn", "Xiaomi QR polling failed", { error });
        await Bun.sleep(2000);
      }
    }
    if (response?.status !== 200) throw new XiaomiError("Xiaomi QR login timed out");
    const data = parseMiResponse(await response.text());
    this.token.ssecurity = stringValue(data.ssecurity);
    this.token.user_id = stringValue(data.userId);
    this.token.pass_token = stringValue(data.passToken);
    this.token.c_user_id = stringValue(data.cUserId);
    const location = stringValue(data.location);
    if (location) {
      const redirect = await this.http.request(location);
      const locationHeader = redirect.headers.get("location") ?? location;
      this.token.service_token =
        stringValue(this.http.cookiesSnapshot.serviceToken) ||
        stringValue(new URL(locationHeader).searchParams.get("serviceToken"));
    }
    if (!this.token.service_token) throw new XiaomiError("Xiaomi login did not return serviceToken");
    await this.stsExchange();
    return this.token;
  }

  async stsExchange(): Promise<void> {
    const query = new URLSearchParams({
      d: this.token.device_id,
      ticket: "0",
      pwd: "0",
      p_ts: String(Date.now()),
      fid: "0",
      p_lm: "2",
      p_ur: "CN",
      sid: "hlth.io.mi.com",
    });
    const clientSign = process.env.MI_CLIENT_SIGN;
    if (clientSign) query.set("clientSign", clientSign);
    const response = await this.http.request(`${STS_URL}?${query}`);
    if (response.ok && (await response.text()).trim() === "ok") {
      const serviceToken = this.http.cookiesSnapshot.serviceToken;
      if (serviceToken) this.token.service_token = serviceToken;
    }
  }

  async refreshWithPassToken(): Promise<AuthToken> {
    if (!this.token.pass_token || !this.token.user_id) {
      throw new TokenExpiredError("Xiaomi passToken credentials are missing");
    }

    this.http.setCookie("passToken", this.token.pass_token);
    this.http.setCookie("deviceId", this.token.device_id);
    this.http.setCookie("userId", this.token.user_id);

    const query = new URLSearchParams({ _json: "true", sid: "miothealth" });
    const response = await this.http.request(`${SERVICE_LOGIN_URL}?${query}`);
    if (!response.ok) throw new TokenExpiredError(`Xiaomi token refresh failed: ${response.status}`);
    const data = parseMiResponse(await response.text());
    const ssecurity = stringValue(data.ssecurity);
    if (!ssecurity) throw new TokenExpiredError("Xiaomi serviceLogin did not return ssecurity");

    const previous = {
      c_user_id: this.token.c_user_id,
      service_token: this.token.service_token,
      ssecurity: this.token.ssecurity,
    };
    const nextCUserId = stringValue(data.cUserId, this.token.c_user_id);
    if (nextCUserId) this.http.setCookie("cUserId", nextCUserId);
    let nextServiceToken = "";
    const location = stringValue(data.location);
    if (location) {
      const nonce = stringValue(data.nonce);
      const clientSign = encodeURIComponent(sha1Base64(`nonce=${nonce}&${ssecurity}`)).replaceAll("%2F", "/");
      const redirect = await this.http.request(`${location}&clientSign=${clientSign}`);
      const locationHeader = redirect.headers.get("location") ?? location;
      const serviceToken =
        stringValue(this.http.cookiesSnapshot.serviceToken) ||
        stringValue(new URL(locationHeader).searchParams.get("serviceToken"));
      if (serviceToken) nextServiceToken = serviceToken;
    }
    await this.stsExchange();
    nextServiceToken ||= stringValue(this.http.cookiesSnapshot.serviceToken);
    if (!nextServiceToken || nextServiceToken === previous.service_token) {
      this.token.c_user_id = previous.c_user_id;
      this.token.service_token = previous.service_token;
      this.token.ssecurity = previous.ssecurity;
      throw new TokenExpiredError("Xiaomi token refresh did not return a new serviceToken");
    }
    this.token.c_user_id = nextCUserId;
    this.token.service_token = nextServiceToken;
    this.token.ssecurity = ssecurity;
    return this.token;
  }
}

export class MiHealthClient {
  private readonly http = new XiaomiHttp({ "user-agent": DEFAULT_UA, region_tag: "ru", handleparams: "true" });
  private refreshPromise: Promise<void> | undefined;
  constructor(
    readonly auth: XiaomiAuth,
    private readonly baseUrl = API_BASE,
  ) {}

  static fromToken(path: string, baseUrl = API_BASE): MiHealthClient {
    return new MiHealthClient(XiaomiAuth.fromToken(path), baseUrl);
  }

  toString(): string {
    return `MiHealthClient(user_id=${this.auth.token.user_id || "N/A"}, base_url=${this.baseUrl})`;
  }

  async request(method: string, path: string, params?: JsonObject, retry = true): Promise<ApiResponse> {
    if (!this.auth.token.service_token || !this.auth.token.ssecurity)
      throw new XiaomiError("Xiaomi token is not authenticated");
    this.http.setCookie("cUserId", this.auth.token.c_user_id);
    this.http.setCookie("serviceToken", this.auth.token.service_token);
    const signingPath = path === "/healthapp/service/gen_download_url" ? "/service/gen_download_url" : path;
    const encoded = encryptedParams(method, signingPath, this.auth.token.ssecurity, params);
    const url = new URL(`${this.baseUrl}${path}`);
    if (method.toUpperCase() === "GET")
      for (const [key, value] of Object.entries(encoded)) url.searchParams.set(key, value);
    const response = await this.http.request(url.toString(), {
      method,
      ...(method.toUpperCase() === "GET" ? {} : { body: new URLSearchParams(encoded) }),
      headers: method.toUpperCase() === "GET" ? undefined : { "content-type": "application/x-www-form-urlencoded" },
    });
    if (response.status === 401) {
      if (!retry || !this.auth.token.pass_token || !this.auth.token.user_id)
        throw new TokenExpiredError("Xiaomi token expired");
      await this.refresh();
      return this.request(method, path, params, false);
    }
    if (!response.ok)
      throw new APIError(`Xiaomi API ${method} ${path} failed: ${response.status}`, { statusCode: response.status });
    const nonce = encoded._nonce;
    if (!nonce) throw new XiaomiError("Xiaomi request nonce is missing");
    const decrypted = decryptResponse(this.auth.token.ssecurity, nonce, await response.text());
    const result = asObject(decrypted);
    const code = numberValue(result.code, -1);
    if (code !== 0) {
      const message = stringValue(result.message ?? result.msg ?? result.desc ?? result.description, "unknown error");
      const requestedKey = stringValue(params?.key);
      if (code === -4002001) throw new FamilyMemberNotFoundError(`Not a family member: ${message}`);
      if (code === -4002004) {
        if (message.toLowerCase().includes("time out of data shared time scope"))
          throw new DataOutOfSharedTimeScopeError(message, requestedKey);
        throw new DataNotSharedError(message, requestedKey);
      }
      throw new APIError(`Xiaomi API error ${code}: ${message}`, { code });
    }
    return result as ApiResponse;
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      await this.auth.refreshWithPassToken();
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async getAggregatedData(
    uid: number,
    key: string,
    start: number,
    end: number,
    limitOrOptions: number | { tag?: string; limit?: number } = 30,
  ): Promise<AggregatedDataItem[]> {
    const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const response = await this.request("GET", "/app/v1/data/get_aggregated_fitness_data_by_time", {
      relative_uid: uid,
      key,
      tag: options.tag ?? "daily_report",
      start_time: start,
      end_time: end,
      limit: options.limit ?? 30,
    });
    const result = asObject(response.result);
    return (Array.isArray(result.data_list) ? result.data_list : []).map(dataItem);
  }

  async getFitnessData(
    uid: number,
    key: string,
    start: number,
    end: number,
    limitOrOptions: number | { limit?: number } = 30,
  ): Promise<AggregatedDataItem[]> {
    const limit = typeof limitOrOptions === "number" ? limitOrOptions : (limitOrOptions.limit ?? 30);
    const response = await this.request("GET", "/app/v1/data/get_fitness_data_by_time", {
      relative_uid: uid,
      key,
      start_time: start,
      end_time: end,
      limit,
    });
    const result = asObject(response.result);
    return (Array.isArray(result.data_list) ? result.data_list : []).map(dataItem);
  }

  async getSteps(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<StepData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "steps", start, end, limit)).map(parseSteps);
  }

  async getSleep(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<SleepData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "sleep", start, end, limit)).map(parseSleep);
  }

  async getHeartRate(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<HeartRateData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "heart_rate", start, end, limit)).map(parseHeartRate);
  }

  async getSpo2History(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<Spo2SummaryData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "spo2", start, end, limit)).map(parseSpo2);
  }

  async getWeightHistory(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<WeightData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end] = dateWindow(days, queryDate);
    return (await this.getFitnessData(uid, "weight", start, end, Math.max(days, 30))).map(parseWeight);
  }

  async getBloodPressureHistory(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<BloodPressureData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end] = dateWindow(days, queryDate);
    return (await this.getFitnessData(uid, "blood_pressure", start, end, Math.max(days, 30))).map(parseBloodPressure);
  }

  async getLatestItems(uid: number): Promise<LatestDataItem[]> {
    const response = await this.request("GET", "/app/v1/data/get_latest_fitness_data", { relative_uid: uid });
    return parseLatestDataItems(asObject(response.result).data_list);
  }

  async getLatestData(uid: number): Promise<LatestDataSnapshot> {
    const response = await this.request("GET", "/app/v1/data/get_latest_fitness_data", { relative_uid: uid });
    const result = asObject(response.result);
    return latestSnapshot(parseLatestDataItems(result.data_list), numberValue(result.latest_data_time));
  }

  private async latestMetric<T>(uid: number, key: string, value: T | null): Promise<T | null> {
    if (value !== null) return value;
    const shared = await this.getSharedDataTypes(uid);
    if (!shared.includes(key)) throw new DataNotSharedError(`Data type is not shared: ${key}`, key);
    return null;
  }

  async getWeight(uid: number): Promise<WeightData | null> {
    return this.latestMetric(uid, "weight", (await this.getLatestData(uid)).weight);
  }

  async getGoal(uid: number): Promise<GoalData | null> {
    return this.latestMetric(uid, "goal", (await this.getLatestData(uid)).goal);
  }

  async getBloodPressure(uid: number): Promise<BloodPressureData | null> {
    return this.latestMetric(uid, "blood_pressure", (await this.getLatestData(uid)).blood_pressure);
  }

  async getCalories(uid: number): Promise<CaloriesData | null> {
    return this.latestMetric(uid, "calories", (await this.getLatestData(uid)).calories);
  }

  async getValidStand(uid: number): Promise<ValidStandData | null> {
    return this.latestMetric(uid, "valid_stand", (await this.getLatestData(uid)).valid_stand);
  }

  async getIntensity(uid: number): Promise<IntensityData | null> {
    return this.latestMetric(uid, "intensity", (await this.getLatestData(uid)).intensity);
  }

  async getSpo2(uid: number): Promise<Spo2Data | null> {
    return this.latestMetric(uid, "spo2", (await this.getLatestData(uid)).spo2);
  }

  async getCaloriesHistory(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<CaloriesData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "calories", start, end, limit)).map((item) => {
      const value = parseAggregated(item, "calories");
      return { time: numberValue(value.time), calories: numberValue(value.calories), goal: numberValue(value.goal) };
    });
  }

  async getValidStandHistory(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<ValidStandData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "valid_stand", start, end, limit)).map((item) => {
      const value = parseAggregated(item, "valid_stand");
      return { time: numberValue(value.time), count: numberValue(value.count) };
    });
  }

  async getIntensityHistory(
    uid: number,
    queryDateOrDays: Date | number = 1,
    options: { days?: number } = {},
  ): Promise<IntensityData[]> {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "intensity", start, end, limit)).map((item) => {
      const value = parseAggregated(item, "intensity");
      return { time: numberValue(value.time), duration: numberValue(value.duration) };
    });
  }

  async getDailySummary(uid: number, queryDate = new Date()): Promise<DailySummary> {
    const [heartRate, sleep, steps] = await Promise.all([
      this.getHeartRate(uid, queryDate)
        .then((items) => items[0] ?? null)
        .catch((error) => {
          if (error instanceof DataNotSharedError) return null;
          throw error;
        }),
      this.getSleep(uid, queryDate)
        .then((items) => items[0] ?? null)
        .catch((error) => {
          if (error instanceof DataNotSharedError) return null;
          throw error;
        }),
      this.getSteps(uid, queryDate)
        .then((items) => items[0] ?? null)
        .catch((error) => {
          if (error instanceof DataNotSharedError) return null;
          throw error;
        }),
    ]);
    return { date: queryDate.toISOString().slice(0, 10), relative_uid: uid, heart_rate: heartRate, sleep, steps };
  }

  async getLatestDailySummary(uid: number): Promise<DailySummary> {
    const member = await this.findRelative(uid);
    const queryDate = member.latest_data_time ? new Date(member.latest_data_time * 1000) : new Date();
    return this.getDailySummary(uid, queryDate);
  }

  async getRelatives(): Promise<FamilyMember[]> {
    const response = await this.request("GET", "/app/v1/relatives/get_relative_list");
    const result = asObject(response.result);
    return (Array.isArray(result.relative_list) ? result.relative_list : []).map((item) => {
      const value = asObject(item);
      return {
        relative_uid: numberValue(value.relative_uid),
        relative_note: stringValue(value.relative_note),
        relative_icon: stringValue(value.relative_icon),
        latest_data_time: numberValue(value.latest_data_time),
        latest_abnormal_record_time: numberValue(value.latest_abnormal_record_time),
        source_tag: numberValue(value.source_tag),
      };
    });
  }

  async findRelative(keyword: string | number): Promise<FamilyMember> {
    const relatives = await this.getRelatives();
    const match = relatives.find((member) =>
      typeof keyword === "number"
        ? member.relative_uid === keyword
        : member.relative_note.toLowerCase().includes(keyword.toLowerCase()),
    );
    if (!match) throw new FamilyMemberNotFoundError(`Relative not found: ${keyword}`);
    return match;
  }

  async verifyUser(verifyId: number, verifyType = 1): Promise<VerifiedUserInfo | null> {
    const response = await this.request("GET", "/app/v1/relatives/verify_userinfo_by_id", {
      verify_id: verifyId,
      verify_type: verifyType,
    });
    const value = asObject(response.result);
    if (!value.userId) return null;
    return { user_id: numberValue(value.userId), nickname: stringValue(value.nickname), icon: stringValue(value.icon) };
  }

  private authContent(sharedDataTypes: string[] | undefined, authTimeRange: number): JsonObject {
    return {
      auth_time_range: authTimeRange,
      auth_data: sharedDataTypes ?? [
        "goal",
        "heart_rate",
        "sleep",
        "blood_pressure",
        "steps",
        "calories",
        "valid_stand",
        "intensity",
        "weight",
        "spo2",
      ],
    };
  }

  async inviteRelative(
    relativeUid: number,
    options: { sharedDataTypes?: string[]; authTimeRange?: number; relativeNote?: string } = {},
  ): Promise<boolean> {
    const params: JsonObject = {
      auth_content: this.authContent(options.sharedDataTypes, options.authTimeRange ?? 3),
      relative_uid: relativeUid,
    };
    if (options.relativeNote) params.relative_note = options.relativeNote;
    const result = asObject((await this.request("POST", "/app/v1/relatives/send_invite", params)).result);
    return numberValue(result.send_ret) === 1;
  }

  async acceptInvite(
    inviteId: number,
    msgId: number,
    options: { sharedDataTypes?: string[]; authTimeRange?: number } = {},
  ): Promise<boolean> {
    return this.operateInvite(inviteId, msgId, 1, options);
  }

  async rejectInvite(inviteId: number, msgId: number): Promise<boolean> {
    return this.operateInvite(inviteId, msgId, 2);
  }

  private async operateInvite(
    inviteId: number,
    msgId: number,
    operate: number,
    options: { sharedDataTypes?: string[]; authTimeRange?: number } = {},
  ): Promise<boolean> {
    const result = asObject(
      (
        await this.request("POST", "/app/v1/relatives/operate_invite", {
          auth_content: this.authContent(options.sharedDataTypes, options.authTimeRange ?? 3),
          invite_id: inviteId,
          msg_id: msgId,
          operate,
        })
      ).result,
    );
    return Boolean(numberValue(result.operate_ret));
  }

  async deleteRelative(relativeUid: number): Promise<boolean> {
    const result = asObject(
      (await this.request("POST", "/app/v1/relatives/delete_relative", { relative_uid: relativeUid })).result,
    );
    return Boolean(numberValue(result.delete_ret));
  }

  async getInviteLinkId(): Promise<number> {
    const result = asObject((await this.request("GET", "/app/v1/relatives/get_invite_unique_id")).result);
    return numberValue(result.invite_link_id);
  }

  async getSharedDataTypes(uid: number, direction = 2): Promise<string[]> {
    const response = await this.request("GET", "/app/v1/relatives/get_shared_data_types", {
      relative_uid: uid,
      type: direction,
    });
    const result = asObject(response.result);
    return Array.isArray(result.keys) ? result.keys.filter((value): value is string => typeof value === "string") : [];
  }

  async getAppliedSharedDataTypes(uid: number): Promise<string[]> {
    const result = asObject(
      (await this.request("GET", "/app/v1/relatives/get_applied_shared_data_types", { relative_uid: uid })).result,
    );
    return Array.isArray(result.keys) ? result.keys.filter((value): value is string => typeof value === "string") : [];
  }

  async getFamilyMembers(): Promise<JsonObject[]> {
    const result = asObject((await this.request("GET", "/app/v1/relatives/get_family_member")).result);
    return Array.isArray(result.family_user_list) ? result.family_user_list.map(asObject) : [];
  }

  async getTopicSubscriptions(uid: number, topics = ["abnormal_event"]): Promise<JsonObject> {
    return asObject(
      (await this.request("GET", "/app/v1/relatives/get_topic_subscriptions", { relative_uid: uid, topics })).result,
    );
  }

  async getInviteMessages(options: { limit?: number; pendingOnly?: boolean } = {}): Promise<InviteMessage[]> {
    const result = asObject(
      (
        await this.request("POST", "/app/v1/message/get_msg_list", {
          module: 1,
          limit: options.limit ?? 30,
        })
      ).result,
    );
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return messages
      .map((item) => {
        const value = asObject(item);
        const rawExtra = value.extra_data;
        const extra = typeof rawExtra === "string" ? parseValue(rawExtra) : asObject(rawExtra);
        const type = numberValue(value.type);
        const dataStatus = numberValue(value.data_status);
        return {
          msg_id: numberValue(value.msg_id),
          module: numberValue(value.module),
          type,
          receiver: numberValue(value.receiver),
          sender: numberValue(value.sender),
          extra_data: typeof rawExtra === "string" ? rawExtra : JSON.stringify(rawExtra ?? {}),
          is_new: numberValue(value.is_new),
          data_status: dataStatus,
          create_time: numberValue(value.create_time),
          last_modify: numberValue(value.last_modify),
          invite_id: extra.invite_id === undefined ? null : numberValue(extra.invite_id),
          nick_name: stringValue(extra.nick_name),
          icon: stringValue(extra.icon),
          is_pending: type === 1 && dataStatus === 0,
        };
      })
      .filter((message) => !options.pendingOnly || message.is_pending);
  }

  async hasNewInvite(): Promise<boolean> {
    const result = (
      await this.request("POST", "/app/v1/message/check_new_msg", {
        module: [1],
        begin_time: 0,
      })
    ).result;
    return (
      Array.isArray(result) &&
      result.some((item) => {
        const value = asObject(item);
        return numberValue(value.module) === 1 && Boolean(numberValue(value.is_new));
      })
    );
  }

  async getFdsDownloadInfo(uid: number, timestamp: number, timezone: number): Promise<JsonObject | null> {
    const tz = Math.abs(timezone) <= 96 ? Math.trunc(timezone) : Math.trunc(timezone / 900);
    const key = Buffer.alloc(6);
    key.writeUInt32LE(timestamp, 0);
    key.writeInt8(tz, 4);
    key.writeUInt8((8 << 2) + 0, 5);
    const suffix = `${urlSafeBase64(key)}_${urlSafeBase64(createHash("sha1").update(String(uid)).digest())}`;
    const response = await this.request("GET", "/healthapp/service/gen_download_url", {
      did: String(uid),
      relative_uid: uid,
      items: [{ timestamp, suffix }],
    });
    const result = asObject(response.result);
    return asObject(result[`${suffix}_${timestamp}`]);
  }

  async close(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export function parseMetric(item: AggregatedDataItem, key: string): number {
  return numberValue(parseAggregated(item, key)[key === "stress" ? "stress" : key]);
}

export function parseMetricObject(item: AggregatedDataItem): JsonObject {
  return parseValue(item.value);
}

export function formatXiaomiError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function decodeFdsAes(content: Uint8Array, objectKey: string): Uint8Array {
  const key = bytes(objectKey);
  const encoded = Buffer.from(content).toString("utf8").trim();
  const encrypted = encoded && /^[A-Za-z0-9_+/=-]+$/.test(encoded) ? bytes(encoded) : content;
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from("1234567887654321", "utf8"));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
