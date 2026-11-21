/**
 * Reminders on the phone. The desktop app sends Feishu cards from a process
 * that is always running; a phone app is stopped in the background, so the
 * reminders are handed to Android ahead of time as local notifications:
 * one 15 minutes before each exact task and one at its start. The list is
 * rebuilt whenever tasks change and whenever the app comes back.
 */
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { App } from "@capacitor/app";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { tasks } from "@personal-ai/db/schema";

const LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const EARLY_MS = 15 * 60 * 1000;

function clock(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/** Android notification ids are 32-bit ints; derive a stable one per task and kind. */
function notificationId(taskId: string, kind: 0 | 1) {
  let hash: number = kind;
  for (const character of taskId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 2_000_000_000;
}

export function startReminderNotifications(db: any) {
  const native = Capacitor.isNativePlatform();
  let timer: number | null = null;
  let running = false;

  async function refresh() {
    if (!native || running) return;
    running = true;
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== "granted") {
        const asked = await LocalNotifications.requestPermissions();
        if (asked.display !== "granted") return;
      }
      const now = new Date();
      const upcoming: Array<{ id: string; title: string; startAt: Date | null }> = await db
        .select({ id: tasks.id, title: tasks.title, startAt: tasks.startAt })
        .from(tasks)
        .where(and(
          eq(tasks.recordKind, "formal"),
          eq(tasks.scheduleKind, "exact"),
          eq(tasks.lifecycleStatus, "open"),
          isNull(tasks.deletedAt),
          gt(tasks.startAt, now),
          lt(tasks.startAt, new Date(now.getTime() + LOOKAHEAD_MS))
        ))
        .orderBy(asc(tasks.startAt))
        .limit(60);

      const pending = await LocalNotifications.getPending();
      if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map(({ id }) => ({ id })) });

      const list = [];
      for (const task of upcoming) {
        if (!task.startAt) continue;
        const start = new Date(task.startAt);
        const early = new Date(start.getTime() - EARLY_MS);
        if (early > now) list.push({ id: notificationId(task.id, 0), title: `15 分钟后开始：${task.title}`, body: `${clock(start)} 开始，先把手头的事收个尾。`, schedule: { at: early, allowWhileIdle: true }, extra: { taskId: task.id } });
        list.push({ id: notificationId(task.id, 1), title: `现在开始：${task.title}`, body: "打开应用进入专注。", schedule: { at: start, allowWhileIdle: true }, extra: { taskId: task.id } });
      }
      if (list.length) await LocalNotifications.schedule({ notifications: list });
    } catch (error) {
      console.warn("Could not schedule reminders", error);
    } finally {
      running = false;
    }
  }

  function refreshSoon() {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 800);
  }

  if (native) {
    void App.addListener("appStateChange", ({ isActive }) => { if (isActive) refreshSoon(); });
    refreshSoon();
  }
  return { refreshSoon };
}
