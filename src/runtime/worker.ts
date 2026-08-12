import { log } from "../logger.js";

export type WorkerHandle = { stop: () => Promise<void> };

export function startIntervalWorker(name: string, intervalMs: number, task: () => void | Promise<void>): WorkerHandle {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new Error("Worker interval must be a positive integer");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  const startCycle = (): void => {
    currentRun = (async () => {
      try {
        await task();
        log("debug", "Worker cycle completed", { worker: name });
      } catch (error) {
        log("error", "Worker cycle failed", { worker: name, error });
      } finally {
        if (!stopped) timer = setTimeout(startCycle, intervalMs);
      }
    })();
  };
  startCycle();
  return {
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) clearTimeout(timer);
      stopPromise = currentRun.then(() => log("info", "Worker stopped", { worker: name }));
      return stopPromise;
    },
  };
}
