/**
 * The phone app's backend: the same services and routes as the desktop API,
 * running inside the app's WebView. Data lives in the WebView's IndexedDB
 * (PGlite "idb://"), and the web app's fetch calls to the API address are
 * answered here instead of over the network.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@personal-ai/db/schema";
import { LocalApp } from "./local-app";
import { migrateInBrowser } from "./migrate";
import { startReminderNotifications } from "./notifications";

import { taskRoutes } from "../../api/src/task-routes";
import { focusRoutes } from "../../api/src/focus-routes";
import { focusStructureRoutes } from "../../api/src/focus-structure-routes";
import { reviewRoutes } from "../../api/src/review-routes";
import { growthRoutes } from "../../api/src/growth-routes";
import { backupRoutes } from "../../api/src/backup-routes";
import { healthRoutes } from "../../api/src/health-routes";
import { longRangePlanRoutes } from "../../api/src/long-range-plan-routes";
import { userProfileRoutes } from "../../api/src/user-profile-routes";
import { desktopCommandRoutes } from "../../api/src/desktop-command-routes";
import { PostgresTaskStore } from "../../api/src/task-repository";
import { TaskService } from "../../api/src/task-service";
import { FocusService } from "../../api/src/focus-service";
import { FocusStructureService } from "../../api/src/focus-structure-service";
import { ReviewService } from "../../api/src/review-service";
import { GrowthService } from "../../api/src/growth-service";
import { BackupService } from "../../api/src/backup-service";
import { HealthService } from "../../api/src/health-service";
import { LongRangePlanService } from "../../api/src/long-range-plan-service";
import { UserProfileService } from "../../api/src/user-profile-service";
import { DesktopCommandService } from "../../api/src/desktop-command-service";

import { ReminderWorker } from "../../worker/src/worker-core";
import { FocusTimerWorker } from "../../worker/src/focus-worker";
import { UnscheduledTaskWorker } from "../../worker/src/unscheduled-task-worker";
import { RecycleRetentionWorker } from "../../worker/src/recycle-retention-worker";
import { OverdueTaskWorker } from "../../worker/src/overdue-task-worker";

const DATABASE = "idb://time-managing-assistant";

export type StageListener = (stage: string) => void;

export async function startLocalBackend(apiBase: string, onStage: StageListener = () => {}): Promise<void> {
  let stage = "打开本机数据库";
  const enter = (next: string) => { stage = next; onStage(next); };
  try {
    onStage(stage);
    let pglite: PGlite;
    try {
      pglite = await PGlite.create(DATABASE, { relaxedDurability: true });
    } catch (first) {
      // Some phone WebViews refuse one large up-front memory block; start smaller and let it grow.
      console.warn("PGlite failed with default memory, retrying smaller", first);
      enter("以较小内存重新打开本机数据库");
      pglite = await PGlite.create(DATABASE, { relaxedDurability: true, initialMemory: 32 * 1024 * 1024 });
    }
    enter("建立数据表");
    const db = drizzle(pglite, { schema });
    await migrateInBrowser(db);
    // Write the new tables to the phone's storage now, so a restart right after
    // the first launch never finds a half-written database.
    enter("保存到手机存储");
    await pglite.syncToFs();
    enter("启动本机服务");
    await startServices(db, apiBase);
  } catch (error: any) {
    const detail = error?.message ?? String(error);
    throw new Error(`${stage}失败：${detail}`, { cause: error });
  }
}

/**
 * The screens only say "请确认 API 正在运行" when a call fails; on a phone there is
 * no console to read, so the real reason is shown in a bar at the top.
 */
let faultBar: HTMLDivElement | null = null;
let appVersion = "";
void import("@capacitor/app").then(({ App }) => App.getInfo()).then((info) => { appVersion = `${info.version} (${info.build})`; }).catch(() => {});

function reportFault(where: string, detail: string) {
  console.error("Local API fault", where, detail);
  if (!faultBar) {
    faultBar = document.createElement("div");
    faultBar.style.cssText = "position:fixed;left:8px;right:8px;top:calc(env(safe-area-inset-top,0px) + 8px);z-index:2147483647;max-height:45vh;overflow:auto;padding:10px 12px;background:#160000;color:#ff4866;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;box-shadow:0 4px 0 #ff1446";
    faultBar.title = "点按关闭";
    faultBar.onclick = () => { faultBar?.remove(); faultBar = null; };
    document.body.appendChild(faultBar);
  }
  const header = `本机接口出错（截图发给开发者，点按关闭）\n版本 ${appVersion || "?"} · ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent}\n`;
  const lines = (faultBar.dataset.lines ? JSON.parse(faultBar.dataset.lines) as string[] : []);
  const line = `${where}: ${detail.slice(0, 600)}`;
  if (!lines.includes(line)) lines.push(line);
  faultBar.dataset.lines = JSON.stringify(lines.slice(-4));
  faultBar.textContent = header + lines.slice(-4).join("\n\n");
}

async function startServices(db: any, apiBase: string): Promise<void> {

  const taskService = new TaskService(new PostgresTaskStore(db as any));
  const services = {
    taskService,
    focusService: new FocusService(db as any),
    focusStructureService: new FocusStructureService(db as any),
    reviewService: new ReviewService(db as any),
    growthService: new GrowthService(db as any),
    backupService: new BackupService(db as any),
    healthService: new HealthService(db as any),
    longRangePlanService: new LongRangePlanService(db as any),
    userProfileService: new UserProfileService(db as any),
    desktopCommandService: new DesktopCommandService(db as any)
  };

  const app = new LocalApp();
  app.get("/health", async () => ({ status: "ok", service: "time-managing-assistant-phone" }));
  const prefix = "/api/v1";
  await app.register(taskRoutes as any, { prefix, taskService });
  await app.register(focusRoutes as any, { prefix, focusService: services.focusService });
  await app.register(focusStructureRoutes as any, { prefix, focusStructureService: services.focusStructureService });
  await app.register(reviewRoutes as any, { prefix, reviewService: services.reviewService });
  await app.register(growthRoutes as any, { prefix, growthService: services.growthService });
  await app.register(backupRoutes as any, { prefix, backupService: services.backupService });
  await app.register(healthRoutes as any, { prefix, healthService: services.healthService });
  await app.register(longRangePlanRoutes as any, { prefix, longRangePlanService: services.longRangePlanService });
  await app.register(userProfileRoutes as any, { prefix, userProfileService: services.userProfileService });
  await app.register(desktopCommandRoutes as any, { prefix, desktopCommandService: services.desktopCommandService });

  const notifications = startReminderNotifications(db as any);

  // Answer the web app's API calls here; everything else goes to the network.
  const base = new URL(apiBase);
  const networkFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), window.location.href);
    if (url.origin !== base.origin) return networkFetch(input as any, init);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    try {
      const body = init?.body !== undefined && init.body !== null ? String(init.body) : request ? await request.text() || null : null;
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? request?.headers).forEach((value, key) => { headers[key] = value; });
      const response = await app.handle(method, url, body, headers);
      if (method !== "GET" && response.ok) notifications.refreshSoon();
      // 4xx answers are normal validation replies; anything 500+ is a fault worth showing.
      if (response.status >= 500) {
        const text = await response.clone().text().catch(() => "");
        let message = text;
        try { message = JSON.parse(text).message ?? text; } catch { /* keep raw text */ }
        reportFault(`${method} ${url.pathname}`, `${response.status} ${message}`);
      }
      return response;
    } catch (error: any) {
      reportFault(`${method} ${url.pathname}`, error?.stack ?? error?.message ?? String(error));
      throw error;
    }
  };

  // The desktop API runs these every second in its own process; here they
  // run while the app is open. Nothing is sent to Feishu from the phone.
  const reminderWorker = new ReminderWorker(db as any);
  const focusWorker = new FocusTimerWorker(db as any);
  const unscheduledTaskWorker = new UnscheduledTaskWorker(db as any);
  const recycleRetentionWorker = new RecycleRetentionWorker(db as any);
  const overdueTaskWorker = new OverdueTaskWorker(db as any);
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (let processed = 0; processed < 50; processed += 1) {
        const dayEnd = await unscheduledTaskWorker.processNext();
        const recycle = await recycleRetentionWorker.processNext();
        const overdue = await overdueTaskWorker.processNext();
        const recovered = await focusWorker.reconcileOverdueSession();
        const focus = recovered ? "completed" : await focusWorker.processNext();
        const reminder = await reminderWorker.processNext(null).catch(() => "idle" as const);
        if (dayEnd === "idle" && recycle === "idle" && overdue === "idle" && focus === "idle" && (reminder === "idle" || reminder === "retry")) break;
      }
    } catch (error) {
      console.error("Background job poll failed", error);
    } finally {
      polling = false;
    }
  }
  window.setInterval(() => void poll(), 1_000);
  await poll();
}
