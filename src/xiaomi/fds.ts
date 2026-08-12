import { gunzipSync, inflateSync } from "node:zlib";
import { decodeFdsAes, type MiHealthClient } from "./client.js";

const VALID_TYPES = [0, 1, 2, 6, 7, 8, 9, 10, 3, 4, 5];
export const FDS_SLEEP_DAILY_TYPE = 8;
export const FDS_ALL_DAY_FILE_TYPE = 0;
export const TIMEZONE_15MIN_LIMIT = 96;
export const SECONDS_PER_15_MINUTES = 900;

export function normalizeTimezoneTo15Min(value: number): number {
  return Math.abs(value) <= TIMEZONE_15MIN_LIMIT ? Math.trunc(value) : Math.trunc(value / SECONDS_PER_15_MINUTES);
}

export function genDataIdKeyBytes(
  timestamp: number,
  timezoneIn15Min: number,
  dailyType: number,
  fileType: number,
  dataType = 0,
  sportType = 0,
): Uint8Array {
  const key = Buffer.alloc(6);
  key.writeUInt32LE(timestamp, 0);
  key.writeInt8(timezoneIn15Min, 4);
  key.writeUInt8((dataType << 7) + (sportType << 2) + (dailyType << 2) + fileType, 5);
  return key;
}

function view(payload: Uint8Array): DataView {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

function readSleepAssistInfo(
  payload: Uint8Array,
  position: number,
  byteCount: number,
  float: boolean,
  unsigned: boolean,
  version: number,
): [{ start_time: number; interval: number; record_count: number; values: Array<number | Uint8Array> } | null, number] {
  if (position + 4 > payload.length) return [null, position];
  const data = view(payload);
  const interval = data.getInt16(position, true);
  const recordCount = data.getInt16(position + 2, true);
  position += 4;
  if (recordCount <= 0) return [null, position];
  const total = byteCount * recordCount + (version >= 2 ? 4 : 0);
  if (position + total > payload.length) return [null, position];
  let startTime = 0;
  if (version >= 2) {
    startTime = data.getUint32(position, true);
    position += 4;
  }
  const values: Array<number | Uint8Array> = [];
  for (let index = 0; index < recordCount; index += 1) {
    if (byteCount === 1) values.push(payload[position] ?? 0);
    else if (byteCount === 2) values.push(unsigned ? data.getUint16(position, true) : data.getInt16(position, true));
    else if (byteCount === 4)
      values.push(
        float
          ? data.getFloat32(position, true)
          : unsigned
            ? data.getUint32(position, true)
            : data.getInt32(position, true),
      );
    else values.push(payload.slice(position, position + byteCount));
    position += byteCount;
  }
  return [{ start_time: startTime, interval, record_count: recordCount, values }, position];
}

export type ParsedSleepDetails = {
  report: Record<string, number | boolean>;
  records: { heart_rate: Array<[number, number]>; spo2: Array<[number, number]> };
};

export function parseAllDaySleepBytes(payload: Uint8Array): ParsedSleepDetails | null {
  if (payload.length < 9) return null;
  try {
    const version = payload[5] ?? 0;
    const validBytes = payload.slice(7, 9);
    const valid = new Map<number, boolean>();
    for (const [index, type] of VALID_TYPES.entries()) {
      valid.set(type, ((validBytes[Math.floor(index / 8)] ?? 0) & (1 << (7 - (index % 8)))) !== 0);
    }
    let position = 9;
    const report: Record<string, number | boolean> = {
      sleepFinish: payload[position] === 1,
      deviceBedTime: view(payload).getUint32(position + 1, true),
      deviceWakeupTime: view(payload).getUint32(position + 5, true),
    };
    position += 9;
    const quality = payload[position] ?? 0;
    if (valid.get(2)) report.sleepQuality = quality;
    position += 1;
    const efficiency = payload[position] ?? 0;
    if (valid.get(6)) report.sleepEfficiency = efficiency;
    position += 1;
    const data = view(payload);
    const entrySleepDuration = data.getUint32(position, true);
    if (valid.get(7)) report.entrySleepDuration = entrySleepDuration;
    position += 4;
    const linBedDuration = data.getUint32(position, true);
    if (valid.get(8)) report.linBedDuration = linBedDuration;
    position += 4;
    const goBedTime = data.getUint32(position, true);
    if (valid.get(9)) report.goBedTime = goBedTime;
    position += 4;
    const leaveBedTime = data.getUint32(position, true);
    if (valid.get(10)) report.leaveBedTime = leaveBedTime;
    position += 4;
    const records: ParsedSleepDetails["records"] = { heart_rate: [], spo2: [] };
    if (valid.get(3)) {
      const [heartRate, next] = readSleepAssistInfo(payload, position, 1, false, false, version);
      position = next;
      if (heartRate)
        heartRate.values.forEach((value, index) => {
          if (typeof value === "number" && value > 0 && value < 255)
            records.heart_rate.push([heartRate.start_time + index * heartRate.interval, value]);
        });
    }
    if (valid.get(4)) {
      const [spo2] = readSleepAssistInfo(payload, position, 1, false, false, version);
      if (spo2)
        spo2.values.forEach((value, index) => {
          if (typeof value === "number" && value > 0 && value <= 100)
            records.spo2.push([spo2.start_time + index * spo2.interval, value]);
        });
    }
    return { report, records };
  } catch {
    return null;
  }
}

export async function downloadAndDecryptSleepDetails(
  client: MiHealthClient,
  uid: number,
  timestamp: number,
  timezone: number,
  logFn: (message: string) => void,
): Promise<Uint8Array | null> {
  const fileInfo = await client.getFdsDownloadInfo(uid, timestamp, timezone);
  if (!fileInfo) return null;
  const url = typeof fileInfo.url === "string" ? fileInfo.url : "";
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) {
    logFn(`FDS download returned HTTP ${response.status}`);
    return null;
  }
  const content = new Uint8Array(await response.arrayBuffer());
  const objectKey = typeof fileInfo.obj_key === "string" ? fileInfo.obj_key : "";
  if (objectKey) {
    try {
      return decodeFdsAes(content, objectKey);
    } catch (error) {
      logFn(`FDS AES decryption failed: ${String(error)}`);
      return null;
    }
  }
  if (content[0] === 0x1f && content[1] === 0x8b) return new Uint8Array(gunzipSync(content));
  if (content[0] === 0x78 && (content[1] === 0x9c || content[1] === 0x01)) return new Uint8Array(inflateSync(content));
  return content;
}

export function androidBase64UrlSafe(value: string | Uint8Array): Uint8Array {
  const text = typeof value === "string" ? value : new TextDecoder().decode(value);
  const normalized = text.trim().replaceAll("\n", "").replaceAll("\r", "");
  return new Uint8Array(Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64url"));
}

export function decompressOrRawFdsContent(
  content: Uint8Array,
  logFn: (message: string) => void = () => undefined,
): Uint8Array {
  try {
    if (content[0] === 0x1f && content[1] === 0x8b) {
      const decompressed = new Uint8Array(gunzipSync(content));
      logFn(`Successfully decompressed GZIP FDS content. Length: ${decompressed.length}`);
      return decompressed;
    }
    if (content[0] === 0x78 && (content[1] === 0x9c || content[1] === 0x01)) {
      const decompressed = new Uint8Array(inflateSync(content));
      logFn(`Successfully decompressed ZLIB FDS content. Length: ${decompressed.length}`);
      return decompressed;
    }
  } catch (error) {
    logFn(`FDS decompression failed: ${String(error)}`);
  }
  return content;
}
