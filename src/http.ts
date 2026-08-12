import type { Bot } from "grammy";
import { webhookCallback } from "grammy";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import type { RuntimeStatus } from "./runtime/status.js";
import type { OpenDatabase } from "./storage/kv.js";

export function createHttpApp(config: AppConfig, bot: Bot | null, database: OpenDatabase, status: RuntimeStatus): Hono {
  const app = new Hono();
  if (config.NODE_ENV !== "production") app.use("*", logger());
  app.get("/", (context) => context.json({ name: config.APP_NAME, status: "ok" }));
  app.get("/healthz", (context) => context.text("ok\n"));
  app.get("/readyz", (context) => {
    try {
      database.sqlite.query("SELECT 1").get();
    } catch (error) {
      log("error", "Readiness check failed", { error });
      return context.text("error\n", 500);
    }
    if (config.BOT_MODE === "polling" && !status.botReady) return context.text("not ready\n", 503);
    return context.text("ready\n");
  });
  if (config.BOT_MODE === "webhook" && bot && config.TELEGRAM_WEBHOOK_SECRET) {
    app.post("/telegram/webhook", webhookCallback(bot, "hono", { secretToken: config.TELEGRAM_WEBHOOK_SECRET }));
  }
  app.onError((error, context) => {
    log("error", "Unhandled HTTP error", { error, path: context.req.path });
    return context.json({ error: "Internal Server Error" }, 500);
  });
  return app;
}
