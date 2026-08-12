type LogLevel = "debug" | "info" | "warn" | "error";

const sensitiveKey = /token|secret|password|api[_-]?key|authorization|cookie|credential|ssecurity|passtoken/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redact(nested)]),
    );
  }
  return value;
}

export function log(level: LogLevel, message: string, details?: unknown): void {
  const safe = details === undefined ? undefined : redact(details);
  const timestamp = new Date().toISOString();
  if (process.env.NODE_ENV === "production") {
    const payload: Record<string, unknown> = { timestamp, level, message };
    if (safe !== undefined) payload.details = safe;
    console.log(JSON.stringify(payload));
    return;
  }
  const suffix = safe === undefined ? "" : ` ${JSON.stringify(safe)}`;
  const output = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`;
  if (level === "error") console.error(output);
  else console.log(output);
}
