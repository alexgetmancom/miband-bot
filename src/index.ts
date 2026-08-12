import { configureBot, createBot, startBotTasks } from "./bot/app.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { log } from "./logger.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { createRuntimeStatus } from "./runtime/status.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { initHealthDb, initStateDb } from "./storage/health.js";
import { migrateDatabase, openDatabase } from "./storage/kv.js";
import { runSync } from "./sync.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initStateDb(config.botStateDbPath);
  for (const uid of config.allowedUserIds) initHealthDb(`${config.dataDir}/miband_${uid}.db`);
  const database = openDatabase(config.botStateDbPath);
  migrateDatabase(database);
  const bot = config.BOT_MODE === "http-only" ? null : createBot(config);
  const status = createRuntimeStatus(config.BOT_MODE);
  const app = createHttpApp(config, bot, database, status);
  const server = Bun.serve({ fetch: app.fetch, hostname: config.BIND_HOST, port: config.PORT });
  const supervisor = new RuntimeSupervisor();

  if (bot) supervisor.register(startBotTasks(bot, config));
  if (config.SYNC_INTERVAL > 0) {
    supervisor.register(
      startIntervalWorker("xiaomi-sync", config.SYNC_INTERVAL * 1000, async () => {
        for (const uid of config.allowedUserIds) await runSync(uid, config);
      }),
    );
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log("info", "Stopping service", { signal });
    await supervisor.stop();
    if (bot?.isRunning()) await bot.stop();
    await stopServerGracefully(server);
    database.close();
    log("info", "Service stopped");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (bot) {
    try {
      await configureBot(bot);
    } catch (error) {
      log("warn", "Failed to configure Telegram commands", { error });
    }
    if (config.BOT_MODE === "polling") {
      void bot
        .start({
          onStart: (info) => {
            status.botReady = true;
            status.botError = null;
            log("info", "Telegram polling started", { username: info.username });
          },
        })
        .catch(async (error) => {
          status.botReady = false;
          status.botError = error instanceof Error ? error.message : String(error);
          log("error", "Telegram polling stopped unexpectedly", { error });
          await shutdown("TELEGRAM_POLLING_FAILED");
          process.exitCode = 1;
        });
    } else if (config.BOT_MODE === "webhook" && config.PUBLIC_WEBHOOK_URL && config.TELEGRAM_WEBHOOK_SECRET) {
      await bot.api.setWebhook(`${config.PUBLIC_WEBHOOK_URL}/telegram/webhook`, {
        secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      });
    }
  }
  log("info", "HTTP server listening", { address: `http://${config.BIND_HOST}:${config.PORT}`, mode: config.BOT_MODE });
}

void main().catch((error) => {
  log("error", "Service startup failed", { error });
  process.exitCode = 1;
});
