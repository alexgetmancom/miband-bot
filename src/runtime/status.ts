import type { AppConfig } from "../config.js";

export type RuntimeStatus = { botReady: boolean; botError: string | null };

export function createRuntimeStatus(mode: AppConfig["BOT_MODE"]): RuntimeStatus {
  return { botReady: mode !== "polling", botError: null };
}
