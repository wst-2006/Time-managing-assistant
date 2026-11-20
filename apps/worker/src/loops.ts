import type { AppDatabase } from "@personal-ai/db/client";
import { ReminderWorker } from "./worker-core.js";
import { FocusTimerWorker } from "./focus-worker.js";
import { FeishuDeliveryProvider, loadFeishuConfig } from "./feishu-delivery.js";
import { UnscheduledTaskWorker } from "./unscheduled-task-worker.js";
import { RecycleRetentionWorker } from "./recycle-retention-worker.js";
import { OverdueTaskWorker } from "./overdue-task-worker.js";

export type BackgroundJobs = { stop(): Promise<void> };

/**
 * Runs reminders, focus timers, day-end carry-over, trash retention and
 * overdue handling inside the API process. The embedded database allows a
 * single process only, so these loops no longer live in a separate worker.
 */
export function startBackgroundJobs(db: AppDatabase, env: NodeJS.ProcessEnv = process.env, logger: Pick<Console, "warn" | "error"> = console): BackgroundJobs {
  const reminderWorker = new ReminderWorker(db);
  const focusWorker = new FocusTimerWorker(db);
  const unscheduledTaskWorker = new UnscheduledTaskWorker(db);
  const recycleRetentionWorker = new RecycleRetentionWorker(db);
  const overdueTaskWorker = new OverdueTaskWorker(db);
  const feishuConfig = loadFeishuConfig(env);
  const provider = feishuConfig ? new FeishuDeliveryProvider(feishuConfig) : null;
  let polling: Promise<void> | null = null;
  let stopped = false;

  async function pollDueJobs() {
    for (let processed = 0; processed < 50 && !stopped; processed += 1) {
      const dayEndResult = await unscheduledTaskWorker.processNext();
      const recycleResult = await recycleRetentionWorker.processNext();
      const overdueTaskResult = await overdueTaskWorker.processNext();
      const recoveredFocus = await focusWorker.reconcileOverdueSession();
      const focusResult = recoveredFocus ? "completed" : await focusWorker.processNext();
      const reminderResult = await reminderWorker.processNext(provider);
      if (dayEndResult === "idle" && recycleResult === "idle" && focusResult === "idle" && reminderResult === "idle" && overdueTaskResult === "idle") return;
    }
  }

  function pollSafely() {
    if (polling || stopped) return polling;
    polling = pollDueJobs()
      .catch((error) => logger.error("Background job poll failed", error))
      .finally(() => { polling = null; });
    return polling;
  }

  if (!provider) logger.warn("Feishu is not configured; reminders stay inside the app.");
  const timer = setInterval(() => void pollSafely(), 1_000);
  void pollSafely();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await polling?.catch(() => undefined);
    }
  };
}
