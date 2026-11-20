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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isFocusMiniWindow ? <FocusMiniWindow /> : <App />}
  </StrictMode>
);
