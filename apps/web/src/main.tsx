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
import { storedPalette } from "./palette";

// Apply the saved palette before the first paint so there is no flash of the other one.
document.documentElement.dataset.palette = storedPalette();
// Keep the separate focus window in step when the palette changes in the main window.
window.addEventListener("storage", (event) => {
  if (event.key === "tma.palette") document.documentElement.dataset.palette = storedPalette();
});

const isFocusMiniWindow = new URLSearchParams(window.location.search).get("focus-mini") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isFocusMiniWindow ? <FocusMiniWindow /> : <App />}
  </StrictMode>
);
