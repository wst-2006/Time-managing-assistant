import { useEffect, useRef } from "react";
import type { FocusTheme } from "@personal-ai/domain/user-profile";
import { inkRgb, isDarkPalette, paperRgb } from "./palette";

type Props = { theme?: FocusTheme; evaluation?: boolean };

// Decorative only: no task state, timers, network access or input handlers.
export function FocusMotionBackdrop({ theme, evaluation = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    const owner = canvas.closest(".focus-theme-cyber, .focus-theme-vapor, .focus-theme-ink, .focus-theme-flip, .focus-theme-nixie");
    const ctx = canvas.getContext("2d");
    if (!ctx || !host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 1, height = 1, time = 0, frame = 0, last = 0, visible = true;
    const activeTheme = () => theme ?? (["ink", "flip", "nixie", "vapor", "cyber"] as const).find(value => owner?.classList.contains(`focus-theme-${value}`));
    const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      const current = activeTheme();
      if (current === "ink") {
        // Poster tunnel: signal-red ground, ink rays to a vanishing point,
        // floor lines streaming toward the viewer and receding wall frames.
        // The clock sits on the horizon, so the warp feels like moving through time.
        ctx.fillStyle = `rgb(${paperRgb()})`; ctx.fillRect(0, 0, width, height);
        const vx = width / 2, vy = height * (evaluation ? .64 : .56);
        const travel = (time * (evaluation ? .08 : .24)) % 1;
        ctx.strokeStyle = `rgba(${inkRgb()},${isDarkPalette() ? .3 : .72})`; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 26; i++) { const x = (i / 26) * width * 2.6 - width * .8; ctx.moveTo(vx, vy); ctx.lineTo(x, height); }
        ctx.stroke();
        for (let i = 0; i < 14; i++) {
          const p = Math.pow((i + travel) / 14, 2.2); const y = vy + (height - vy) * p; if (y <= vy + 1) continue;
          ctx.globalAlpha = Math.min(1, p * 3); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        }
        for (let i = 0; i < 8; i++) {
          const p = Math.pow((i + travel) / 8, 2); const lx = vx - (vx + width * .05) * p, rx = vx + (width - vx + width * .05) * p;
          const top = vy - (vy - height * .05) * p, floor = vy + (height - vy) * p;
          ctx.globalAlpha = Math.min(1, p * 2.4); ctx.beginPath();
          ctx.moveTo(lx, floor); ctx.lineTo(lx, top); ctx.lineTo(lx - width * .2 * p, top);
          ctx.moveTo(rx, floor); ctx.lineTo(rx, top); ctx.lineTo(rx + width * .2 * p, top); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (current === "flip") {
        ctx.fillStyle = "#f0f2f2"; ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = "rgba(43,62,68,.045)"; ctx.lineWidth = 1;
        for (let x = 20; x < width; x += 32) for (let y = 20; y < height; y += 32) {
          ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x + 2, y); ctx.moveTo(x, y - 2); ctx.lineTo(x, y + 2); ctx.stroke();
        }
        const rail = height - 25;
        ctx.strokeStyle = "rgba(49,65,69,.2)";
        for (let x = 24, i = 0; x < width - 24; x += 10, i++) { ctx.beginPath(); ctx.moveTo(x, rail); ctx.lineTo(x, rail + (i % 5 === 0 ? 8 : 4)); ctx.stroke(); }
        const carriage = 24 + (width - 48) * (.5 + .45 * Math.sin(time * .13));
        ctx.fillStyle = "#287c83"; ctx.fillRect(carriage - 3, rail - 4, 6, 3);
      } else if (current === "nixie") {
        ctx.fillStyle = "#101719"; ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = "rgba(137,160,157,.07)"; ctx.lineWidth = 1;
        for (let y = 12; y < height; y += 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
        const base = height - 38;
        ctx.strokeStyle = "rgba(117,160,154,.25)";
        ctx.beginPath(); ctx.moveTo(22, base - 10); ctx.lineTo(width * .2, base - 10); ctx.lineTo(width * .2 + 10, base); ctx.lineTo(width - 22, base); ctx.stroke();
        ctx.save(); ctx.strokeStyle = `rgba(111,214,191,${.2 + Math.sin(time * .65) * .06})`; ctx.beginPath();
        for (let x = 22; x < width - 22; x += 3) {
          const y = base + Math.sin(x * .055 - time * .6) * 3;
          if (x === 22) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke(); ctx.restore();
        ctx.fillStyle = "#5b706e";
        for (const x of [14, width - 14]) for (const y of [14, height - 14]) {
          ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
        }
      } else if (current === "cyber") {
        ctx.fillStyle = "#060e10"; ctx.fillRect(0, 0, width, height);
        const strength = evaluation ? .44 : .55;
        const step = width < 600 ? 24 : 29;
        ctx.font = "12px Consolas, monospace"; ctx.textAlign = "center";
        for (let col = 0; col < Math.ceil(width / step); col++) {
          const x = col * step + 12, edge = Math.abs(x - width / 2) / (width / 2);
          const alpha = (.055 + .65 * edge * edge) * strength;
          const head = (time * (22 + hash(col) * 24) + hash(col + 90) * (height + 250)) % (height + 250) - 80;
          for (let row = 0; row < 17; row++) {
            const y = head - row * 17;
            if (y < 10 || y > height - 15) continue;
            ctx.fillStyle = row === 0 ? `rgba(188,250,194,${Math.min(.7, alpha * 1.8)})` : `rgba(92,211,163,${alpha * (1 - row / 18)})`;
            ctx.fillText(hash(col * 101 + row + Math.floor(time * .6)) > .5 ? "1" : "0", x, y);
          }
        }
      } else if (current === "vapor") {
        const sky = ctx.createLinearGradient(0, 0, 0, height);
        sky.addColorStop(0, "#0c1029"); sky.addColorStop(.48, "#241638"); sky.addColorStop(.75, "#51243c"); sky.addColorStop(1, "#111226");
        ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
        const horizon = height * .73, radius = Math.min(width * .16, height * .14);
        const sunY = horizon - radius * .92 + Math.sin(time * .28) * (evaluation ? 2 : 4);
        ctx.save(); ctx.globalAlpha = evaluation ? .28 : .65;
        ctx.beginPath(); ctx.arc(width / 2, sunY, radius, 0, Math.PI * 2); ctx.clip();
        const sun = ctx.createLinearGradient(0, sunY - radius, 0, sunY + radius);
        sun.addColorStop(0, "#ffc999"); sun.addColorStop(.48, "#ff88a5"); sun.addColorStop(1, "#ef3d99"); ctx.fillStyle = sun;
        let start = sunY - radius;
        for (let i = 0; i < 7; i++) {
          const y = sunY + radius * .05 + i * radius * .14;
          ctx.fillRect(width / 2 - radius, start, radius * 2, Math.max(0, y - start)); start = y + 2 + i * .6;
        }
        ctx.fillRect(width / 2 - radius, start, radius * 2, Math.max(0, sunY + radius - start)); ctx.restore();
        ctx.save(); ctx.globalAlpha = evaluation ? .3 : .6;
        for (let layer = 0; layer < 2; layer++) {
          ctx.fillStyle = layer ? "#111527" : "#27203a"; ctx.beginPath(); ctx.moveTo(0, horizon + 40);
          for (let i = 0; i <= 18; i++) {
            const x = i * width / 18, central = Math.abs(x - width / 2) / (width / 2);
            ctx.lineTo(x, horizon - (18 + hash(i + layer * 38) * 67) * (.35 + central * .9) + layer * 23);
          }
          ctx.lineTo(width, horizon + 50); ctx.closePath(); ctx.fill();
        }
        ctx.restore(); ctx.fillStyle = "#101225"; ctx.fillRect(0, horizon, width, height - horizon);
        ctx.strokeStyle = `rgba(241,94,186,${evaluation ? .2 : .48})`; ctx.lineWidth = 1;
        for (let i = -12; i <= 12; i++) { ctx.beginPath(); ctx.moveTo(width / 2 + i * 8, horizon); ctx.lineTo(width / 2 + i * width * .15, height); ctx.stroke(); }
        for (let i = 0; i < 22; i++) {
          const z = (i / 22 + time * .033) % 1, y = horizon + z * z * (height - horizon);
          ctx.globalAlpha = .18 + .82 * z; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const fade = ctx.createLinearGradient(0, horizon, 0, horizon + 60);
        fade.addColorStop(0, "#25192ae6"); fade.addColorStop(1, "#11122500"); ctx.fillStyle = fade; ctx.fillRect(0, horizon, width, 60);
        ctx.fillStyle = "rgba(210,226,255,.3)";
        for (let i = 0; i < 35; i++) ctx.fillRect(hash(i + 199) * width, 20 + hash(i + 89) * height * .27, 1, 1);
      }
    }
    function tick(stamp: number) {
      frame = 0;
      if (document.hidden || !visible || reduced.matches) return;
      if (!last || stamp - last >= 32) { time += last ? Math.min((stamp - last) / 1000, .1) : 0; last = stamp; draw(); }
      frame = requestAnimationFrame(tick);
    }
    function resume() {
      cancelAnimationFrame(frame); frame = 0; last = 0;
      const enabled = Boolean(activeTheme());
      canvas!.style.display = enabled ? "block" : "none";
      draw();
      if (enabled && visible && !document.hidden && !reduced.matches) frame = requestAnimationFrame(tick);
    }
    function resize() {
      if (!canvas || !ctx || !host) return;
      width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); draw();
    }
    const sizeObserver = new ResizeObserver(resize); sizeObserver.observe(host);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; resume(); }); intersection.observe(canvas);
    const themeObserver = new MutationObserver(resume);
    if (owner && !theme) themeObserver.observe(owner, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", resume); reduced.addEventListener("change", resume);
    resize(); resume();
    return () => { cancelAnimationFrame(frame); sizeObserver.disconnect(); intersection.disconnect(); themeObserver.disconnect(); document.removeEventListener("visibilitychange", resume); reduced.removeEventListener("change", resume); };
  }, [theme, evaluation]);
  return <canvas className="focus-motion-backdrop" ref={ref} aria-hidden="true" />;
}
