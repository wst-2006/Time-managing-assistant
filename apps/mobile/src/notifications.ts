/**
 * Reminders on the phone. A phone app is stopped in the background, so every
 * reminder is handed to Android ahead of time as a local notification:
 * 15 minutes and 1 minute before each exact task, at its start, when a focus
 * segment hands over to a break (and back), and at its fixed end. The title is
 * the task's name; the text says what is happening. Which kinds are sent is set
 * on the settings page; each notification can be swiped away. The list is
 * rebuilt whenever tasks change, settings change or the app comes back.
 */
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { App } from "@capacitor/app";
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { focusStructureSegments, focusStructures, tasks } from "@personal-ai/db/schema";
import { PHONE_NOTIFICATIONS_CHANGED, readPhoneNotificationSettings } from "./notification-settings";

const LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const CHANNEL = "tma-reminders";
const TEST_ID = 1;

function clock(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(date);
}

/** Android notification ids are 32-bit ints; a stable one per task and reminder. */
function notificationId(taskId: string, key: string) {
  let hash = 7;
  for (const character of `${taskId}:${key}`) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return 10 + (Math.abs(hash) % 2_000_000_000);
}

type Reminder = { id: number; title: string; body: string; at: Date; taskId: string };

export function startReminderNotifications(db: any) {
  const native = Capacitor.isNativePlatform();
  let timer: number | null = null;
  let running = false;
  let again = false;
  let channelReady = false;

  async function ensureChannel() {
    if (channelReady) return;
    // Importance 3: sound and a place in the notification shade, no pop-up over the screen.
    await LocalNotifications.createChannel({ id: CHANNEL, name: "任务提醒", description: "开始前、开始时、休息切换与结束", importance: 3, visibility: 1, vibration: true }).catch(() => undefined);
    channelReady = true;
  }

  async function ensurePermission(ask: boolean) {
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display === "granted" || !ask) return permission.display === "granted";
    return (await LocalNotifications.requestPermissions()).display === "granted";
  }

  async function plannedReminders(now: Date): Promise<Reminder[]> {
    const settings = readPhoneNotificationSettings();
    const rows: Array<{ id: string; title: string; startAt: Date | null; endAt: Date | null; lifecycleStatus: string }> = await db
      .select({ id: tasks.id, title: tasks.title, startAt: tasks.startAt, endAt: tasks.endAt, lifecycleStatus: tasks.lifecycleStatus })
      .from(tasks)
      .where(and(
        eq(tasks.recordKind, "formal"),
        eq(tasks.scheduleKind, "exact"),
        inArray(tasks.lifecycleStatus, ["open", "active"]),
        isNull(tasks.deletedAt),
        gt(tasks.endAt, now),
        lt(tasks.startAt, new Date(now.getTime() + LOOKAHEAD_MS))
      ))
      .orderBy(asc(tasks.startAt))
      .limit(40);

    const reminders: Reminder[] = [];
    for (const task of rows) {
      if (!task.startAt || !task.endAt) continue;
      const start = new Date(task.startAt);
      const end = new Date(task.endAt);
      const add = (key: string, at: Date, body: string) => {
        if (at > now) reminders.push({ id: notificationId(task.id, key), title: task.title, body, at, taskId: task.id });
      };
      if (task.lifecycleStatus === "open") {
        if (settings.before15) add("before15", new Date(start.getTime() - 15 * MINUTE), `15 分钟后开始 · ${clock(start)}–${clock(end)}`);
        if (settings.before1) add("before1", new Date(start.getTime() - MINUTE), "1 分钟后开始，准备进入专注");
        if (settings.start) add("start", start, `现在开始 · 到 ${clock(end)} 结束`);
      }
      if (settings.segments) {
        const [structure] = await db.select({ id: focusStructures.id, totalStartAt: focusStructures.totalStartAt })
          .from(focusStructures)
          .where(and(eq(focusStructures.taskId, task.id), eq(focusStructures.state, "active")))
          .limit(1);
        if (structure) {
          const segments: Array<{ position: number; segmentType: string; durationMinutes: number }> = await db
            .select({ position: focusStructureSegments.position, segmentType: focusStructureSegments.segmentType, durationMinutes: focusStructureSegments.durationMinutes })
            .from(focusStructureSegments)
            .where(eq(focusStructureSegments.focusStructureId, structure.id))
            .orderBy(asc(focusStructureSegments.position));
          let boundary = new Date(structure.totalStartAt).getTime();
          segments.forEach((segment, index) => {
            boundary += segment.durationMinutes * MINUTE;
            const next = segments[index + 1];
            if (!next || boundary >= end.getTime()) return;
            const at = new Date(boundary);
            add(`segment-${next.position}`, at, next.segmentType === "break"
              ? `专注段结束，休息 ${next.durationMinutes} 分钟`
              : `休息结束，继续专注 ${next.durationMinutes} 分钟`);
          });
        }
      }
      if (settings.end) add("end", end, "计时结束，记得给这次专注打个分");
    }
    return reminders.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, 120);
  }

  async function refresh() {
    if (!native) return;
    if (running) { again = true; return; }
    running = true;
    try {
      if (!(await ensurePermission(true))) return;
      await ensureChannel();
      const reminders = await plannedReminders(new Date());
      const pending = await LocalNotifications.getPending();
      const stale = pending.notifications.filter(({ id }) => id !== TEST_ID);
      if (stale.length) await LocalNotifications.cancel({ notifications: stale.map(({ id }) => ({ id })) });
      if (reminders.length) {
        await LocalNotifications.schedule({
          notifications: reminders.map((reminder) => ({
            id: reminder.id,
            title: reminder.title,
            body: reminder.body,
            channelId: CHANNEL,
            autoCancel: true,
            schedule: { at: reminder.at, allowWhileIdle: true },
            extra: { taskId: reminder.taskId }
          }))
        });
      }
    } catch (error) {
      console.warn("Could not schedule reminders", error);
    } finally {
      running = false;
      if (again) { again = false; refreshSoon(); }
    }
  }

  function refreshSoon() {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 800);
  }

  if (native) {
    void App.addListener("appStateChange", ({ isActive }) => { if (isActive) refreshSoon(); });
    window.addEventListener(PHONE_NOTIFICATIONS_CHANGED, refreshSoon);
    (window as any).tmaPhoneNotifications = {
      async status() {
        const permission = (await LocalNotifications.checkPermissions()).display;
        const exact = await LocalNotifications.checkExactNotificationSetting().then((s) => s.exact_alarm).catch(() => "granted");
        const pending = (await LocalNotifications.getPending()).notifications.length;
        return { permission, exact, pending };
      },
      async sendTest() {
        if (!(await ensurePermission(true))) throw new Error("没有通知权限：请在系统设置里允许本应用发送通知。");
        await ensureChannel();
        await LocalNotifications.schedule({ notifications: [{ id: TEST_ID, title: "时间管理助手", body: "测试通知：任务提醒会像这样出现。", channelId: CHANNEL, autoCancel: true, schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true } }] });
      }
    };
    refreshSoon();
  }
  return { refreshSoon };
}
