import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

export const DEFAULT_STEP_GOAL = 10_000;
const SPORT_TYPES: Record<Locale, Record<string, string>> = {
  en: {
    free_training: "Free training",
    outdoor_running: "Outdoor running",
    treadmill: "Treadmill",
    walking: "Walking",
    cycling: "Cycling",
    swimming: "Swimming",
    yoga: "Yoga",
    strength_training: "Strength training",
    hiit: "HIIT",
    jump_rope: "Jump rope",
    elliptical: "Elliptical",
    rowing: "Rowing",
    outdoor_cycling: "Outdoor cycling",
    basketball: "Basketball",
    football: "Football",
    table_tennis: "Table tennis",
    badminton: "Badminton",
    tennis: "Tennis",
    volleyball: "Volleyball",
    dancing: "Dancing",
    martial_arts: "Martial arts",
  },
  ru: {
    free_training: "Свободная тренировка",
    outdoor_running: "Бег на улице",
    treadmill: "Беговая дорожка",
    walking: "Ходьба",
    cycling: "Велосипед",
    swimming: "Плавание",
    yoga: "Йога",
    strength_training: "Силовая",
    hiit: "HIIT",
    jump_rope: "Скакалка",
    elliptical: "Эллипсоид",
    rowing: "Гребля",
    outdoor_cycling: "Велосипед (улица)",
    basketball: "Баскетбол",
    football: "Футбол",
    table_tennis: "Настольный теннис",
    badminton: "Бадминтон",
    tennis: "Теннис",
    volleyball: "Волейбол",
    dancing: "Танцы",
    martial_arts: "Боевые искусства",
  },
  es: {
    free_training: "Entrenamiento libre",
    outdoor_running: "Carrera al aire libre",
    treadmill: "Cinta de correr",
    walking: "Caminar",
    cycling: "Ciclismo",
    swimming: "Natación",
    yoga: "Yoga",
    strength_training: "Fuerza",
    hiit: "HIIT",
    jump_rope: "Saltar a la cuerda",
    elliptical: "Elíptica",
    rowing: "Remo",
    outdoor_cycling: "Ciclismo al aire libre",
    basketball: "Baloncesto",
    football: "Fútbol",
    table_tennis: "Tenis de mesa",
    badminton: "Bádminton",
    tennis: "Tenis",
    volleyball: "Voleibol",
    dancing: "Baile",
    martial_arts: "Artes marciales",
  },
};
const DEFAULT_TIME_ZONE = "Europe/Moscow";

export function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function epoch(value: unknown, withDate = true, locale: Locale = "en", timeZone = DEFAULT_TIME_ZONE): string {
  const seconds = Number(value);
  if (!seconds) return t(locale, "common.na");
  const date = new Date(seconds * 1000);
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : locale === "es" ? "es-ES" : "en-GB", {
    timeZone,
    ...(withDate ? { dateStyle: "short" } : {}),
    timeStyle: "short",
  }).format(date);
}

export function minutes(value: unknown, locale: Locale = "en"): string {
  if (value === null || value === undefined) return t(locale, "common.na");
  const total = Number(value);
  return `${Math.floor(total / 60)} ${t(locale, "common.hours")} ${String(Math.floor(total % 60)).padStart(2, "0")} ${t(locale, "common.minutes")}`;
}

export function sleepTotal(row: Record<string, unknown>): number {
  const total = Number(row.total_duration_min ?? 0);
  return total > 0 ? total : Number(row.light_sleep_min ?? 0) + Number(row.deep_sleep_min ?? 0);
}

export function sparkline(values: number[]): string {
  if (!values.length) return "";
  const marks = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return (marks[4] ?? "▄").repeat(Math.min(values.length, 20));
  return values.map((value) => marks[Math.floor(((value - min) / (max - min)) * 7)] ?? " ").join("");
}

export function stepBar(value: unknown, goal = DEFAULT_STEP_GOAL): string {
  const steps = Number(value ?? 0);
  const percent = goal > 0 ? Math.min(100, Math.round((steps / goal) * 100)) : 0;
  const blocks = Math.floor(percent / 10);
  return `<code>[${"█".repeat(blocks)}${"░".repeat(10 - blocks)}]</code> ${percent}%`;
}

function dateKey(value: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function relativeDay(day: string | undefined, locale: Locale = "en", timeZone = DEFAULT_TIME_ZONE): string {
  if (!day) return t(locale, "common.day");
  const today = dateKey(Date.now(), timeZone);
  const yesterday = dateKey(Date.now() - 86_400_000, timeZone);
  return day === today ? t(locale, "common.today") : day === yesterday ? t(locale, "common.yesterday") : day;
}

export function workoutType(value: unknown, locale: Locale = "en"): string {
  const key = String(value ?? "unknown");
  return SPORT_TYPES[locale][key] ?? key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function rowNumber(row: Record<string, unknown> | null | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

export function rowString(row: Record<string, unknown> | null | undefined, key: string): string {
  return String(row?.[key] ?? "");
}
