// Drives the app through a short, choreographed demo for a promo video.
// Uses a throwaway data folder (your real data is never touched), starts the
// API and web app, opens Edge full-screen and waits for you to start screen
// recording (OBS, or Win+Alt+R with Xbox Game Bar), then press Space in the
// browser to roll. See docs/PROMO.md.
//
//   corepack pnpm promo                 # Edge, full screen
//   PROMO_BROWSER=chrome corepack pnpm promo
//   PROMO_NO_WAIT=1 ...                 # start immediately, no Space
//
// Run between 08:00 and 20:30: the demo schedules tasks around "now".
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const workspace = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const require = createRequire(join(workspace, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const corepack = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
const tempPrefix = join(tmpdir(), "tma-promo-");
const tempRoot = await mkdtemp(tempPrefix);
const children = [];
const TZ = "Asia/Shanghai";

// ---------- processes ----------
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`)));
  });
}
function start(command, args, env, cwd = workspace) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  children.push(child);
  return child;
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.unref(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
async function waitFor(url, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 400)); }
  throw new Error(`Timed out waiting for ${url}`);
}
async function cleanup() {
  for (const child of children) { try { child.kill(); } catch {} }
  if (tempRoot.startsWith(tempPrefix)) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void cleanup().finally(() => process.exit(130)));

// ---------- demo data ----------
function shanghaiNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
const at = (date, minute) => `${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`;

async function seed(api) {
  const sql = (q, params = []) => fetch(`${api}/__e2e/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q, params }) }).then((r) => r.json());
  const { date, minute } = shanghaiNow();
  if (minute < 8 * 60 || minute > 20 * 60 + 30) throw new Error("请在 08:00–20:30 之间运行：演示会围绕当前时间排任务。");
  const slot = Math.floor(minute / 30) * 30;            // current half hour
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const plan = [
    // [title, start, end, status, outcome]
    ["背单词", 8 * 60, 8 * 60 + 30, "closed", "complete"],
    ["读完第三章并整理笔记", 9 * 60, 10 * 60 + 30, "closed", "partial"],
    ["数据库大作业", slot - 30, slot + 60, "open", null],      // already started: the page offers GO
    ["跑步", slot + 120, slot + 180, "open", null],
    ["复盘今天", 21 * 60 + 30, 22 * 60, "open", null],
  ].filter(([, start, end]) => end <= 23 * 60 && (start >= slot - 30 || end <= slot - 30));
  let index = 0;
  for (const [title, startMinute, endMinute, status, outcome] of plan) {
    // created tomorrow (always allowed), then moved to today's slot
    const placeholder = 8 * 60 + index * 60; index += 1;
    const created = await fetch(`${api}/api/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, scheduleKind: "exact", timeZone: TZ, startAt: at(tomorrow, placeholder), endAt: at(tomorrow, placeholder + 30) }) }).then((r) => r.json());
    const id = created.task?.id;
    if (!id) throw new Error(`Could not create demo task ${title}: ${JSON.stringify(created)}`);
    await sql("update tasks set start_at=$1, end_at=$2, local_date=$3, lifecycle_status=$4, current_outcome=$5, schedule_revision=schedule_revision+1 where id=$6", [at(date, startMinute), at(date, endMinute), date, status, outcome, id]);
  }
  await fetch(`${api}/api/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "整理房间", scheduleKind: "none", localDate: date, timeZone: TZ }) });
  if (process.env.PROMO_SHOTS) console.log("seeded", JSON.stringify(await sql("select title, start_at, local_date, lifecycle_status from tasks order by start_at").then((r) => r.rows)));
  return { date, slot };
}

const growthSummary = (() => {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10);
    const m = [95, 150, 0, 210, 60, 180, 120][i], p = [4, 5, 3, 5, 4, 4, 3][i], c = [4, 3, 0, 5, 2, 4, 3][i];
    return { localDate: d, focusMinutes: m, closedTasks: c, completedTasks: c, plannedTasks: p, tone: "steady", points: 50, pointsBreakdown: { execution: 20, focus: 15, satisfaction: 10, review: 5 } };
  });
  return { range: { start: days[0].localDate, end: days[6].localDate }, selectedDate: days[6].localDate, days, focusTrend: { granularity: "day", points: days.map((d) => ({ startDate: d.localDate, endDate: d.localDate, focusMinutes: d.focusMinutes })) }, focusMinutes: 815, plannedTasks: 28, closedTasks: 21, completedTasks: 21, periodGrowthPercent: 72, satisfaction: { satisfied: 9, neutral: 4, dissatisfied: 2 }, radar: [], currentRadar: [], currentRadarSaved: false, garden: { points: 60, pointsBreakdown: { execution: 30, focus: 18, satisfaction: 12, review: 6 }, scoredDays: 6, growthPercent: 72, growthCap: 100, baseGrowthScore: 60, executionPercent: 75, satisfactionPercent: 70, bambooCount: 6, treeKind: "竹", quality: 70 } };
})();

// ---------- on-screen helpers (cursor, captions, popup) ----------
const overlayScript = () => {
  if (window.top !== window) return;
  const install = () => {
    const style = document.createElement("style");
    style.textContent = `
      #promo-cursor{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border:2px solid #160000;border-radius:50%;pointer-events:none;z-index:2147483647;transition:transform .12s,background-color .12s;mix-blend-mode:normal}
      #promo-cursor.down{transform:scale(.72);background:rgba(22,0,0,.85)}
      #promo-card{position:fixed;inset:0;z-index:2147483600;pointer-events:none;display:grid;place-content:center;justify-items:center;gap:26px;background:#120306;color:#ff4866;opacity:0;transition:opacity .5s}
      #promo-card.on{opacity:1}
      #promo-card b{font:400 clamp(72px,9vw,160px)/1 var(--font-display-zh);letter-spacing:.06em}
      #promo-card small{font:500 clamp(16px,1.4vw,26px)/1.4 var(--font-mono);letter-spacing:.32em}
      #promo-popup{position:fixed;right:36px;bottom:36px;width:360px;height:360px;border:0;z-index:2147483500;box-shadow:0 24px 60px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.4);transform:translateY(120%);transition:transform .7s cubic-bezier(.2,.9,.2,1)}
      #promo-popup.on{transform:none}
      body *:not(input):not(textarea){user-select:none!important}`;
    document.head.appendChild(style);
    const cursor = document.createElement("div"); cursor.id = "promo-cursor"; document.body.appendChild(cursor);
    addEventListener("pointermove", (e) => { cursor.style.left = e.clientX + "px"; cursor.style.top = e.clientY + "px"; }, true);
    addEventListener("pointerdown", () => cursor.classList.add("down"), true);
    addEventListener("pointerup", () => cursor.classList.remove("down"), true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install); else install();
};

// ---------- main ----------
try {
  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const api = `http://127.0.0.1:${apiPort}`, web = `http://127.0.0.1:${webPort}`;
  console.log("构建后台……");
  await run(process.execPath, [corepack, "pnpm", "--filter", "@personal-ai/domain", "--filter", "@personal-ai/db", "--filter", "@personal-ai/worker", "--filter", "@personal-ai/api", "-r", "run", "build"]);
  const env = { ...process.env, TMA_DATA_DIR: join(tempRoot, "data"), API_PORT: String(apiPort), TMA_E2E_ISOLATED: "1", TMA_DISABLE_BACKGROUND_JOBS: "1", VITE_API_BASE_URL: api,
    // the API only accepts known web origins; this is how the test runner adds its own
    PLAYWRIGHT_WEB_BASE_URL: web };
  delete env.FEISHU_APP_ID; delete env.FEISHU_APP_SECRET; delete env.TMA_ENV_FILE;
  console.log("启动演示用的后台和界面……");
  start(process.execPath, [join(workspace, "apps/api/dist/server.js")], env);
  start(process.execPath, [corepack, "pnpm", "exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], env, join(workspace, "apps/web"));
  await waitFor(`${api}/health`); await waitFor(web);
  const { slot } = await seed(api);

  const headless = process.env.PROMO_HEADLESS === "1";
  const browser = await chromium.launch({
    headless,
    channel: process.env.PROMO_BROWSER_PATH ? undefined : (process.env.PROMO_BROWSER ?? "msedge"),
    executablePath: process.env.PROMO_BROWSER_PATH,
    args: headless ? [] : ["--start-fullscreen", "--hide-crash-restore-bubble", "--disable-infobars"],
  });
  const context = await browser.newContext(headless ? { viewport: { width: 1920, height: 1080 } } : { viewport: null });
  await context.addInitScript(overlayScript);
  await context.route("**/api/v1/growth/summary**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ summary: growthSummary }) }));
  const page = await context.newPage();
  await page.goto(web, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // smooth pointer with ease-in-out, ~60 fps
  let pointer = { x: 200, y: 200 };
  async function glide(x, y, ms = 700) {
    const from = { ...pointer }, frames = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= frames; i++) {
      const t = i / frames, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await page.waitForTimeout(16);
    }
    pointer = { x, y };
  }
  async function glideTo(locator, ms, dx = 0.5, dy = 0.5) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox(); if (!box) throw new Error("element not visible");
    await glide(box.x + box.width * dx, box.y + box.height * dy, ms);
  }
  async function click(locator, ms = 650) { await glideTo(locator, ms); await page.mouse.down(); await page.waitForTimeout(110); await page.mouse.up(); }
  async function smoothScroll(total, ms = 1400) { const steps = Math.round(ms / 16); for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, total / steps); await page.waitForTimeout(16); } }
  const card = (big, small, on = true) => page.evaluate(([big, small, on]) => {
    let el = document.getElementById("promo-card");
    if (!el) { el = document.createElement("div"); el.id = "promo-card"; document.body.appendChild(el); }
    if (big) el.innerHTML = `<b>${big}</b><small>${small}</small>`;
    requestAnimationFrame(() => el.classList.toggle("on", on));
  }, [big, small, on]);
  const snap = (name) => process.env.PROMO_SHOTS ? page.screenshot({ path: join(process.env.PROMO_SHOTS, `${name}.png`) }) : null;
  async function step(name, body) {
    try { await body(); } catch (error) { console.warn(`[跳过] ${name}: ${String(error?.message ?? error).split("\n")[0]}`); console.warn(String(error?.message ?? "").split("\n").filter((l) => l.includes("waiting for")).join(" ")); await snap(`fail-${name}`); }
  }
  const nav = (name) => click(page.locator(".app-rail").getByRole("button", { name, exact: true }));

  await card("把一天排清楚", "PLANNER · 时间管理助手");
  if (process.env.PROMO_NO_WAIT !== "1" && !headless) {
    console.log("\n浏览器已全屏打开。先开始录屏，然后在浏览器里按空格键开始演示。");
    await page.evaluate(() => addEventListener("keydown", (event) => { if (event.code === "Space") window.__promoGo = true; }));
    await page.waitForFunction(() => window.__promoGo === true, null, { timeout: 0, polling: 200 });
  }
  console.log("开始演示");
  await page.waitForTimeout(2600);
  await card(null, null, false); await page.waitForTimeout(900);

  await snap("start");
  // 1. Today: look around, then draw a task on the whole-day timeline
  await step("今日", async () => {
    await glide(700, 380, 900); await page.waitForTimeout(600);
    const whole = page.getByRole("button", { name: "全天", exact: true });
    await click(whole); await page.waitForTimeout(900);
    const grid = page.locator('.day-grid[data-surface-id="combined"]');
    await grid.waitFor({ timeout: 5000 });
    const free = slot + 60;                             // between 数据库大作业 and 跑步
    const hourLine = grid.locator(".hour-line").filter({ hasText: `${String(Math.floor(free / 60)).padStart(2, "0")}:00` });
    // scroll with the wheel over the timeline until the target hour sits mid-box
    const gridArea = await grid.boundingBox();
    await glide(gridArea.x + gridArea.width * 0.5, Math.min(gridArea.y + 260, 700), 700);
    for (let i = 0; i < 40; i++) {
      const line = await hourLine.boundingBox();
      const view = page.viewportSize() ?? { height: await page.evaluate(() => innerHeight) };
      if (line && line.y > view.height * 0.35 && line.y < view.height * 0.6) break;
      await page.mouse.wheel(0, line && line.y < view.height * 0.35 ? -60 : 60);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(500);
    await page.waitForTimeout(300);
    const lineBox = await hourLine.boundingBox(), gridBox = await grid.boundingBox();
    if (!lineBox || !gridBox) throw new Error("timeline not visible");
    const x = gridBox.x + gridBox.width * 0.55, y = lineBox.y + (free % 60) / 60 * 72 + 4;
    await glide(x, y, 800); await page.mouse.down();
    await glide(x, y + 70, 900); await page.mouse.up();
    const title = page.getByLabel("任务标题");
    await title.waitFor({ timeout: 3000 });
    await title.click(); await page.keyboard.type("高等代数", { delay: 140 });
    await page.waitForTimeout(500);
    await click(page.getByRole("button", { name: "保存任务" }));
    await page.waitForTimeout(1600);
  });
  await snap("today");
  await card("排进时间轴", "拖一拖就排好 · 状态一眼看清"); await page.waitForTimeout(1700); await card(null, null, false); await page.waitForTimeout(600);

  // 2. Focus: pick the task, push the lines like a knob, GO
  await step("专注", async () => {
    await nav("专注"); await page.waitForTimeout(1600);
    const slip = page.locator(".focus-task-slip").filter({ hasText: "数据库大作业" }).first();
    if (await slip.isVisible().catch(() => false)) { await click(slip); await page.waitForTimeout(900); }
    const confirm = page.getByRole("button", { name: "确认并使用" });
    if (await confirm.isVisible().catch(() => false)) { await click(confirm); await page.waitForTimeout(900); }
    await page.evaluate(() => scrollTo({ top: 0, behavior: "smooth" })); await page.waitForTimeout(800);
    const timer = page.locator(".focus-timepiece").first();
    await timer.waitFor({ timeout: 5000 });
    const tbox = await timer.boundingBox();
    if (tbox) {
      const cx = tbox.x + tbox.width / 2;
      await glide(cx, tbox.y + tbox.height * 0.85, 900);
      for (let i = 0; i < 2; i++) { await glide(cx + 30, tbox.y + tbox.height * 0.25, 650); await page.waitForTimeout(900); await glide(cx, tbox.y + tbox.height * 0.8, 1100); await page.waitForTimeout(400); }
      await page.waitForTimeout(1200);
    }
    await snap("focus-knob");
    const begin = page.locator(".focus-main-action");
    if (await begin.isVisible().catch(() => false)) { await click(begin); await page.waitForTimeout(1400); }
    const go = page.locator(".focus-execution-go").first();
    await go.waitFor({ timeout: 5000 });
    await go.scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
    await glideTo(go, 900); await page.waitForTimeout(700);
    await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
    await page.waitForTimeout(3800);
    await page.evaluate(() => scrollTo({ top: 0, behavior: "smooth" })); await page.waitForTimeout(800);
  });
  await snap("go");
  // 3. The desktop focus popup slides in
  await page.evaluate((src) => { const f = document.createElement("iframe"); f.id = "promo-popup"; f.src = src; document.body.appendChild(f); setTimeout(() => f.classList.add("on"), 1400); }, `${web}/?focus-mini=1`);
  await page.waitForTimeout(2600);
  const popup = await page.locator("#promo-popup").boundingBox();
  if (popup) { await glide(popup.x + 60, popup.y + 90, 1000); await glide(popup.x + 300, popup.y + 250, 1600); await glide(popup.x + 180, popup.y + 160, 900); }
  await page.waitForTimeout(2200);
  await snap("popup");
  await page.evaluate(() => document.getElementById("promo-popup")?.classList.remove("on")); await page.waitForTimeout(800);
  await card("留下真实记录", "每一分钟专注都会被看见"); await page.waitForTimeout(1700); await card(null, null, false); await page.waitForTimeout(600);

  // 4. Growth
  await page.evaluate(() => document.getElementById("promo-popup")?.remove());
  await nav("成长"); await page.waitForTimeout(2400);
  await glide(900, 520, 900); await page.waitForTimeout(800);
  await smoothScroll(700, 2200); await page.waitForTimeout(1600);
  await smoothScroll(500, 1600); await page.waitForTimeout(1800);

  await snap("growth");
  // 5. End card
  await card("PLANNER", "github.com/wst-2006/Time-managing-assistant"); await page.waitForTimeout(3500);
  console.log("演示结束，可以停止录屏。");
  if (headless) await page.screenshot({ path: join(workspace, "promo-last-frame.png") });
  await page.waitForTimeout(2000);
  await browser.close();
} finally {
  await cleanup();
}
