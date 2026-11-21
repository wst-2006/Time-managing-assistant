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

// The phone build carries its own backend (database, services, timers) and
// starts it before the first screen; the desktop build talks to its local API.
if (import.meta.env.VITE_TMA_TARGET === "mobile") {
  import("@tma-mobile/backend")
    .then(({ startLocalBackend }) => startLocalBackend(import.meta.env.VITE_API_BASE_URL ?? "http://tma.local"))
    .catch((error) => { console.error("The phone backend failed to start", error); document.body.dataset.backendError = String(error?.message ?? error); })
    .finally(render);
} else {
  render();
}
