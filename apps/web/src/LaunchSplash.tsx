import { useEffect, useState } from "react";

/**
 * A short launch mark shown only while the shell mounts. It never holds the
 * app hostage: it leaves after the first painted frames (~450ms) instead of
 * playing a fixed-length loading animation.
 */
export function LaunchSplash() {
  const [leaving, setLeaving] = useState(false);
  const [visible, setVisible] = useState(() => typeof navigator === "undefined" || !navigator.webdriver);

  useEffect(() => {
    if (!visible) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let removeTimer = 0;
    const leaveTimer = window.setTimeout(() => {
      setLeaving(true);
      removeTimer = window.setTimeout(() => setVisible(false), reducedMotion ? 20 : 260);
    }, reducedMotion ? 60 : 420);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(removeTimer);
    };
  }, [visible]);

  if (!visible) return null;
  return <section className={`ink-loading-screen ${leaving ? "is-leaving" : ""}`} aria-label="正在打开个人 AI 助手" aria-live="polite">
    <div className="ink-loading-center">
      <span className="ink-loading-seal" aria-hidden="true">序</span>
    </div>
  </section>;
}
