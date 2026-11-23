// Installs the phone app on an Android emulator (in CI) and checks what a person would notice:
// it opens within seconds, every screen's data loads, a new task is saved, and the task is still
// there after the app is closed and opened again. Results go to the job summary.
//
//   node scripts/android-emulator-check.mjs path/to/app.apk
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const apk = process.argv[2];
const appId = "com.wst2006.timemanagingassistant";
const startupLimitMs = Number(process.env.TMA_STARTUP_LIMIT_MS ?? 15000);
const report = [];
let failed = false;

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function note(ok, text) {
  report.push(`${ok ? "✅" : "❌"} ${text}`);
  console.log(`${ok ? "::notice::" : "::error::"}${text}`);
  if (!ok) failed = true;
}

async function connectToApp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const pid = (() => { try { return adb("shell", "pidof", appId).trim().split(/\s+/)[0]; } catch { return ""; } })();
    const sockets = adb("shell", "cat", "/proc/net/unix").match(/@(webview_devtools_remote_\d+)/g) ?? [];
    const own = sockets.find((socket) => pid && socket.endsWith(`_${pid}`));
    if (own) {
      const name = own.slice(1);
      try { adb("forward", "--remove", "tcp:9333"); } catch { /* not forwarded yet */ }
      adb("forward", "tcp:9333", `localabstract:${name}`);
      try {
        const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
        const page = targets.find((target) => target.type === "page");
        if (page) return openSession(page.webSocketDebuggerUrl);
      } catch { /* WebView not ready yet */ }
    }
    await sleep(500);
  }
  throw new Error("The app's WebView never appeared");
}

function openSession(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    socket.onerror = () => reject(new Error("Could not connect to the app's WebView"));
    socket.onopen = () => resolve({
      async evaluate(expression) {
        const message = await new Promise((done) => {
          id += 1;
          pending.set(id, done);
          socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
        });
        if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description ?? "evaluate failed");
        return message.result?.result?.value;
      },
      close() { socket.close(); }
    });
  });
}

async function launch(label) {
  adb("shell", "am", "force-stop", appId);
  const started = Date.now();
  adb("shell", "am", "start", "-W", "-n", `${appId}/.MainActivity`);
  const session = await connectToApp();
  let startup = null;
  while (Date.now() - started < 120000) {
    startup = await session.evaluate("JSON.stringify(window.__tmaStartup ?? null)").then(JSON.parse).catch(() => null);
    if (startup) break;
    await sleep(250);
  }
  const wall = Date.now() - started;
  if (!startup) { note(false, `${label}: app never finished starting (waited ${wall} ms)`); return session; }
  if (!startup.ready) { note(false, `${label}: startup failed — ${startup.error}`); return session; }
  note(startup.ms <= startupLimitMs, `${label}: data ready ${startup.ms} ms after the page loaded (${wall} ms from tap, limit ${startupLimitMs} ms)`);
  return session;
}

const call = (path, method = "GET", body) => `fetch("http://tma.local/api/v1${path}", ${JSON.stringify({ method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })}).then(async (r) => ({ status: r.status, body: await r.text() }))`;

try {
  adb("install", "-r", apk);
  // Android 13+ asks for notification permission with a dialog; grant it up front as a person would.
  try { adb("shell", "pm", "grant", appId, "android.permission.POST_NOTIFICATIONS"); } catch { /* not needed before Android 13 */ }
  const sdk = adb("shell", "getprop", "ro.build.version.sdk").trim();
  const webview = adb("shell", "dumpsys", "package", "com.google.android.webview").match(/versionName=([\d.]+)/)?.[1] ?? "unknown";
  report.push(`Android API ${sdk}, WebView ${webview}`);

  let session = await launch("First start (creates the database)");
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const screens = [
    ["今日 tasks", `/tasks?date=${today}`], ["回收站", "/tasks/trash"], ["设置", "/user-profile"],
    ["专注 current", "/focus-sessions/current"], ["专注 pending evaluation", "/focus-sessions/pending-evaluation"],
    ["规划", "/long-range-plans"], ["复盘", `/reviews/${today}`], ["成长", `/growth/summary?endDate=${today}&days=7`],
    ["健康", `/health/days/${today}`]
  ];
  for (const [name, path] of screens) {
    const result = await session.evaluate(call(path));
    note(result.status < 500, `${name} ${path} → ${result.status}${result.status >= 400 ? ` ${result.body.slice(0, 200)}` : ""}`);
  }

  const title = `模拟器检查 ${Date.now()}`;
  const created = await session.evaluate(call("/tasks", "POST", { title, scheduleKind: "none", localDate: today, timeZone: "Asia/Shanghai" }));
  note(created.status === 201, `New task saved → ${created.status}${created.status !== 201 ? ` ${created.body.slice(0, 300)}` : ""}`);

  // Reminders: an exact task starting at the next half hour + 30 min gets 15-min, 1-min, start and end notifications.
  // Tomorrow 09:00–10:00 Shanghai time: inside the 07:00–23:00 scheduling hours whenever this runs.
  const tomorrow = new Date(Date.now() + 8 * 3600 * 1000 + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const start = new Date(`${tomorrow}T01:00:00.000Z`);
  const end = new Date(`${tomorrow}T02:00:00.000Z`);
  const reminderTitle = `提醒检查 ${Date.now() % 100000}`;
  const exact = await session.evaluate(call("/tasks", "POST", { title: reminderTitle, scheduleKind: "exact", startAt: start.toISOString(), endAt: end.toISOString(), timeZone: "Asia/Shanghai" }));
  note(exact.status === 201, `Timed task saved → ${exact.status}${exact.status !== 201 ? ` ${exact.body.slice(0, 300)}` : ""}`);
  await sleep(4000);
  const pending = await session.evaluate("window.Capacitor.Plugins.LocalNotifications.getPending().then((r) => r.notifications.map((n) => ({ title: n.title, body: n.body })))");
  const mine = pending.filter((n) => n.title === reminderTitle).map((n) => n.body);
  for (const expected of ["15 分钟后开始", "1 分钟后开始", "现在开始", "计时结束"]) {
    note(mine.some((body) => body.includes(expected)), `Reminder scheduled: 「${reminderTitle}」${expected}`);
  }
  const status = await session.evaluate("window.tmaPhoneNotifications.status()");
  note(status.permission === "granted", `Notification permission: ${status.permission}`);
  note(status.exact === "granted", `On-the-minute alarms: ${status.exact}`);
  await session.evaluate("window.tmaPhoneNotifications.sendTest()");
  let shown = false;
  try { adb("logcat", "-c"); } catch { /* best effort */ }
  const testSentAt = Date.now();
  for (let i = 0; i < 90 && !shown; i += 1) {
    await sleep(1000);
    // The test notification has id 1; older Android prints records as "NotificationRecord(... pkg=<app> ... id=1 ...".
    shown = adb("shell", "dumpsys", "notification").split("\n").some((line) => line.includes(`pkg=${appId}`) && /\bid=1\b/.test(line));
  }
  note(shown, `Test notification appeared in the notification shade${shown ? ` (${Math.round((Date.now() - testSentAt) / 1000)} s after asking, 5 s requested)` : ""}`);
  if (!shown) {
    const lines = adb("shell", "dumpsys", "notification").split("\n").filter((line) => line.includes(appId)).slice(0, 15);
    console.log(`Notification records for the app:\n${lines.join("\n") || "(none)"}`);
    console.log(`Pending: ${JSON.stringify(await session.evaluate("window.Capacitor.Plugins.LocalNotifications.getPending()")).slice(0, 600)}`);
    console.log(adb("shell", "dumpsys", "alarm").split("\n").filter((line) => line.includes(appId)).slice(0, 10).join("\n"));
    console.log(`Device time: ${adb("shell", "date", "+%s").trim()} host: ${Math.round(Date.now() / 1000)}`);
    console.log(`Log:\n${adb("logcat", "-d").split("\n").filter((line) => /notif|alarm|Capacitor|TimedNotification|chromium/i.test(line)).slice(-40).join("\n")}`);
  }
  session.close();

  session = await launch("Second start");
  const listed = await session.evaluate(call(`/tasks?date=${today}`));
  note(listed.status === 200 && listed.body.includes(title), "The new task is still there after closing and reopening the app");
  const faults = await session.evaluate("document.body.innerText.includes('本机接口出错') ? document.body.innerText.slice(0, 400) : ''");
  note(!faults, faults ? `Error bar shown: ${faults}` : "No error bar on screen");
  session.close();

  mkdirSync("emulator-check", { recursive: true });
  writeFileSync("emulator-check/screen.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
} catch (error) {
  note(false, `Check stopped: ${error.message}`);
}

const summary = `### Phone app on the emulator\n\n${report.join("\n\n")}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(failed ? 1 : 0);
