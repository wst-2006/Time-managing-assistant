/**
 * Which reminders the phone sends. Kept on the phone itself (localStorage):
 * they only describe this phone's notifications, so they never travel with the
 * shared profile. Read by notifications.ts, edited on the settings page.
 */
export type PhoneNotificationKind = "before15" | "before1" | "start" | "segments" | "end";

export type PhoneNotificationSettings = Record<PhoneNotificationKind, boolean>;

export const phoneNotificationLabels: Array<[PhoneNotificationKind, string, string]> = [
  ["before15", "开始前 15 分钟", "例如「高等数学 · 15 分钟后开始」。"],
  ["before1", "开始前 1 分钟", "倒计时一分钟，准备进入专注。"],
  ["start", "开始时", "到点提醒开始。"],
  ["segments", "专注与休息切换", "按专注安排，在休息开始和休息结束时各提醒一次。"],
  ["end", "计时结束", "任务的固定结束时间到了。"]
];

const KEY = "tma.phone-notifications";
const DEFAULTS: PhoneNotificationSettings = { before15: true, before1: true, start: true, segments: true, end: true };
export const PHONE_NOTIFICATIONS_CHANGED = "tma:phone-notifications-changed";

export function readPhoneNotificationSettings(): PhoneNotificationSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<PhoneNotificationSettings>;
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePhoneNotificationSettings(settings: PhoneNotificationSettings) {
  try { window.localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable: keep defaults */ }
  window.dispatchEvent(new Event(PHONE_NOTIFICATIONS_CHANGED));
}

/** Set by the phone backend; the settings page uses it for the status line and the test button. */
export type PhoneNotificationControls = {
  status(): Promise<{ permission: string; exact: string; pending: number }>;
  sendTest(): Promise<void>;
};
export function phoneNotificationControls(): PhoneNotificationControls | null {
  return ((window as any).tmaPhoneNotifications as PhoneNotificationControls | undefined) ?? null;
}
