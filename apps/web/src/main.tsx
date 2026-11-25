// First: adds newer browser functions on phones with an older WebView (see the file).
import "@tma-mobile/polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./ui/tokens.css";
import "./ui/base.css";
import "./ui/shell.css";
import "./ui/today.css";
import "./focus-mini.css";
import "./focus-themes.css";
import "./focus-motion.css";
import "./ui/focus.css";
import "./ui/review.css";
import "./ui/growth.css";
import "./ui/plans.css";
import "./ui/health.css";
import "./ui/settings.css";
import { App } from "./App";
import { FocusMiniWindow } from "./FocusMiniWindow";

const isFocusMiniWindow = new URLSearchParams(window.location.search).get("focus-mini") === "1";

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {isFocusMiniWindow ? <FocusMiniWindow /> : <App />}
    </StrictMode>
  );
}

/** Phone build only: the built-in data store could not start, so say exactly why instead of showing empty pages. */
function showBackendError(error: unknown) {
  const message = error instanceof Error ? `${error.message}${error.cause instanceof Error && error.cause.stack ? `\n\n${error.cause.stack}` : ""}` : String(error);
  const root = document.getElementById("root")!;
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.style.cssText = "min-height:100vh;box-sizing:border-box;padding:48px 24px;background:#ff1446;color:#160000;font:16px/1.6 system-ui,sans-serif;display:grid;align-content:start;gap:16px";
  const title = document.createElement("h1");
  title.textContent = "本机数据没能启动";
  title.style.cssText = "margin:0;font-size:28px";
  const hint = document.createElement("p");
  hint.textContent = "手机版的数据存在这台手机里，由 App 自己启动，不需要单独的 API。下面是具体原因，请截图发给开发者。";
  hint.style.margin = "0";
  const detail = document.createElement("pre");
  detail.textContent = message;
  detail.style.cssText = "margin:0;padding:12px;background:#160000;color:#ff4866;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto";
  const retry = document.createElement("button");
  retry.textContent = "重试";
  retry.style.cssText = "justify-self:start;padding:12px 28px;border:0;background:#160000;color:#ff1446;font-size:16px";
  retry.onclick = () => location.reload();
  panel.append(title, hint, detail, retry);
  root.appendChild(panel);
}

// The phone build carries its own backend (database, services, timers) and
// starts it before the first screen; the desktop build talks to its local API.
if (import.meta.env.VITE_TMA_TARGET === "mobile") {
  const root = document.getElementById("root")!;
  root.innerHTML = '<div style="min-height:100vh;display:grid;place-content:center;gap:10px;justify-items:center;text-align:center;padding:0 24px;background:#ff1446;color:#160000;font:15px/1.5 system-ui,sans-serif"><b style="font-size:20px">正在准备本机数据</b><span>第一次打开可能要一分钟左右，请不要退出</span><small id="tma-stage" style="opacity:.7"></small></div>';
  const startedAt = Date.now();
  let stage = "加载程序";
  const stageLabel = () => document.getElementById("tma-stage");
  const showStage = () => { const el = stageLabel(); if (el) el.textContent = `${stage} · ${Math.round((Date.now() - startedAt) / 1000)} 秒`; };
  const ticker = window.setInterval(showStage, 1000);
  showStage();
  // Slow phones can need well over a minute the first time; only give up when a step is truly stuck.
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`启动超时：3 分钟后仍停在「${stage}」这一步\n${navigator.userAgent}`)), 180_000));
  Promise.race([
    import("@tma-mobile/backend").then(({ startLocalBackend }) => startLocalBackend(import.meta.env.VITE_API_BASE_URL ?? "http://tma.local", (next) => { stage = next; showStage(); })),
    timeout,
  ])
    .then(() => {
      window.clearInterval(ticker);
      // Read by the emulator check in CI to confirm the phone app starts quickly.
      (window as any).__tmaStartup = { ms: Math.round(performance.now()), ready: true };
      root.innerHTML = "";
      render();
    })
    .catch((error) => {
      window.clearInterval(ticker);
      console.error("The phone backend failed to start", error);
      (window as any).__tmaStartup = { ms: Math.round(performance.now()), ready: false, error: String(error?.message ?? error) };
      showBackendError(error);
    });
} else if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  // Desktop: the window opens at once while the local service starts behind it;
  // keep the launch mark up until the service answers, then show the app.
  void waitForDesktopService().then(() => {
    render();
    if (!isFocusMiniWindow) void import("./desktop-reminders").then(({ startDesktopReminders }) => startDesktopReminders());
  });
} else {
  render();
}

async function waitForDesktopService() {
  const api = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
  // Only "does the service accept connections" matters here, so the check does not depend on CORS.
  const ready = () => fetch(`${api}/health`, { cache: "no-store", mode: "no-cors" }).then(() => true).catch(() => false);
  if (await ready()) return;
  const root = document.getElementById("root")!;
  root.innerHTML = '<section class="ink-loading-screen" aria-live="polite"><div class="ink-loading-center"><span class="ink-loading-seal" aria-hidden="true">序</span><p id="tma-desktop-wait" style="margin:18px 0 0;font:14px/1.6 system-ui,sans-serif;text-align:center">正在启动本机服务…</p></div></section>';
  const startedAt = Date.now();
  while (!(await ready())) {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const label = document.getElementById("tma-desktop-wait");
    if (label) label.textContent = seconds < 90
      ? `正在启动本机服务… ${seconds} 秒`
      : "本机服务还没有启动。请稍等，或退出后重新打开；仍不行请把应用数据目录里的 desktop-runtime.log 和 api.stderr.log 发给开发者。";
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  root.innerHTML = "";
}
