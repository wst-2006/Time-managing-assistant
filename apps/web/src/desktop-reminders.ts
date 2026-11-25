/**
 * Windows: "高等数学 · 15 分钟后开始" reminders. The desktop companion already
 * notifies when focus starts, switches between focus and break, and ends, and
 * opens the 准备 window one minute before; this adds the early reminder that
 * used to come only from Feishu. Runs in the main window, which stays loaded
 * while it sits in the tray.
 */
import { invokeDesktop, type FocusMiniSettings } from "./focus-session-client";

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const EARLY_MINUTES = 15;
const SENT_KEY = "tma.desktop-reminders-sent";

type ReminderTask = { id: string; title: string; startAt: string | null; endAt: string | null; lifecycleStatus: string; scheduleKind: string; recordKind: string };

function shanghaiDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function clock(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function readSent(): Record<string, number> {
  try { return JSON.parse(window.localStorage.getItem(SENT_KEY) ?? "{}") as Record<string, number>; } catch { return {}; }
}
function writeSent(sent: Record<string, number>) {
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  const kept = Object.fromEntries(Object.entries(sent).filter(([, at]) => at > cutoff));
  try { window.localStorage.setItem(SENT_KEY, JSON.stringify(kept)); } catch { /* storage unavailable */ }
}

async function check() {
  const settings = await invokeDesktop<FocusMiniSettings>("focus_mini_settings").catch(() => null);
  if (!settings || settings.notifyUpcoming === false) return;
  const now = new Date();
  const days = [...new Set([shanghaiDate(now), shanghaiDate(new Date(now.getTime() + EARLY_MINUTES * 60_000))])];
  const sent = readSent();
  for (const day of days) {
    const response = await fetch(`${API}/api/v1/tasks?date=${day}`).catch(() => null);
    if (!response?.ok) continue;
    const { tasks } = await response.json() as { tasks: ReminderTask[] };
    for (const task of tasks) {
      if (task.recordKind !== "formal" || task.scheduleKind !== "exact" || task.lifecycleStatus !== "open" || !task.startAt || !task.endAt) continue;
      const start = new Date(task.startAt);
      const minutesLeft = Math.round((start.getTime() - now.getTime()) / 60_000);
      // From 15 minutes out until the 1-minute 准备 window takes over.
      if (minutesLeft > EARLY_MINUTES || minutesLeft < 2) continue;
      const key = `${task.id}@${task.startAt}`;
      if (sent[key]) continue;
      sent[key] = Date.now();
      writeSent(sent);
      await invokeDesktop("desktop_notify", { title: task.title, body: `${minutesLeft} 分钟后开始 · ${clock(start)}–${clock(new Date(task.endAt))}` }).catch(() => undefined);
    }
  }
}

let started = false;
export function startDesktopReminders() {
  if (started) return;
  started = true;
  void check();
  window.setInterval(() => void check(), 20_000);
}
