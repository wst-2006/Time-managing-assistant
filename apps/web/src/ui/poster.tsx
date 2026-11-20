import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const INK = "22,0,0";
const reduce = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Shared pointer, normalised to -1..1, smoothed. */
const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
if (typeof window !== "undefined") addEventListener("pointermove", (e) => { pointer.tx = (e.clientX / innerWidth) * 2 - 1; pointer.ty = (e.clientY / innerHeight) * 2 - 1; });

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, c: HTMLCanvasElement) => void, deps: unknown[] = []) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fn = useRef(draw); fn.current = draw;
  useEffect(() => {
    const c = ref.current!; const ctx = c.getContext("2d")!;
    let raf = 0, w = 0, h = 0; const t0 = performance.now();
    const fit = () => { const d = Math.min(2, devicePixelRatio || 1); w = c.clientWidth; h = c.clientHeight; c.width = w * d; c.height = h * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
    fit(); const ro = new ResizeObserver(fit); ro.observe(c);
    let onScreen = true;
    const io = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => { onScreen = !!entry?.isIntersecting; });
    io?.observe(c);
    const still = reduce();
    const loop = (now: number) => {
      if ((onScreen && !document.hidden) || still) {
        pointer.x += (pointer.tx - pointer.x) * 0.06; pointer.y += (pointer.ty - pointer.y) * 0.06;
        ctx.clearRect(0, 0, w, h); fn.current(ctx, w, h, still ? 0 : (now - t0) / 1000, c);
      }
      if (!still) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io?.disconnect(); };
  }, deps);
  return ref;
}

/**
 * Perspective tunnel: floor grid streams toward the viewer, side walls are
 * stacked boxes, the vanishing point follows the pointer. `speed` > 1 = warp.
 */
export function Tunnel({ horizon = 0.62, speed = 1, walls = true, className = "art" }: { horizon?: number; speed?: number; walls?: boolean; className?: string }) {
  const sp = useRef(speed); sp.current = speed;
  const travelled = useRef(0); const last = useRef(0);
  const ref = useCanvas((ctx, w, h, t) => {
    const dt = Math.min(0.05, t - last.current); last.current = t;
    travelled.current += dt * 0.18 * sp.current;
    const vx = w / 2 + pointer.x * w * 0.04, vy = h * horizon + pointer.y * h * 0.03;
    ctx.strokeStyle = `rgba(${INK},.8)`; ctx.lineWidth = 1;
    // floor rays
    const rays = 28;
    for (let i = 0; i <= rays; i++) { const x = (i / rays) * w * 2.6 - w * 0.8; ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(x, h); ctx.stroke(); }
    // floor cross lines with perspective, streaming
    const rows = 14;
    for (let i = 0; i < rows; i++) {
      const z = ((i + (travelled.current % 1)) / rows); const p = Math.pow(z, 2.2);
      const y = vy + (h - vy) * p; if (y <= vy + 1) continue;
      ctx.globalAlpha = Math.min(1, p * 3); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!walls) return;
    // walls: nested boxes receding to the vanishing point
    for (let i = 0; i < 9; i++) {
      const z = ((i + (travelled.current % 1)) / 9); const p = Math.pow(z, 2);
      const lx = vx - (vx + w * 0.05) * p, rx = vx + (w - vx + w * 0.05) * p;
      const top = vy - (vy - h * 0.06) * p;
      ctx.globalAlpha = Math.min(1, p * 2.5);
      ctx.beginPath(); ctx.moveTo(lx, vy + (h - vy) * p); ctx.lineTo(lx, top); ctx.moveTo(rx, vy + (h - vy) * p); ctx.lineTo(rx, top); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx, top); ctx.lineTo(lx - w * 0.2 * p, top); ctx.moveTo(rx, top); ctx.lineTo(rx + w * 0.2 * p, top); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const side of [-1, 1]) for (let k = 1; k <= 3; k++) {
      const yy = vy - (vy - h * 0.06) * (k / 4);
      ctx.beginPath(); ctx.moveTo(vx, vy - (vy - yy) * 0.02); ctx.lineTo(side < 0 ? -w * 0.05 : w * 1.05, yy + (vy - yy) * 0); ctx.stroke();
    }
  }, [horizon]);
  return <canvas ref={ref} className={className} aria-hidden />;
}

/** Contour-like wave field that bends away from the pointer. */
export function Waves({ lines = 46, className = "art", amp = 1 }: { lines?: number; className?: string; amp?: number }) {
  const ref = useCanvas((ctx, w, h, t, c) => {
    const r = c.getBoundingClientRect();
    const px = (pointer.x * 0.5 + 0.5) * innerWidth - r.left, py = (pointer.y * 0.5 + 0.5) * innerHeight - r.top;
    ctx.strokeStyle = `rgba(${INK},.7)`; ctx.lineWidth = 1;
    for (let i = 0; i < lines; i++) {
      const base = (i / (lines - 1)) * h * 1.1 - h * 0.05;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const n = x / w;
        let y = base + Math.sin(n * 5.2 + t * 0.45 + i * 0.09) * 18 * amp + Math.sin(n * 2.1 - t * 0.3 + i * 0.05) * 30 * amp * n;
        const dx = x - px, dy = y - py; const d2 = dx * dx + dy * dy;
        y += (dy / Math.sqrt(d2 + 1)) * 60 * Math.exp(-d2 / 9000);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
  return <canvas ref={ref} className={className} aria-hidden />;
}

/** Sunburst: rays + dome. `rise` 0..1 lifts the sun above the horizon. */
export function Sun({ rise = 0.5, children, rays = 36 }: { rise?: number; children?: ReactNode; rays?: number }) {
  return <div className="sun">
    <motion.svg className="sun-rays" viewBox="-500 -500 1000 1000" animate={{ rotate: 360 }} transition={{ duration: 240, repeat: Infinity, ease: "linear" }} aria-hidden>
      {Array.from({ length: rays }, (_, i) => { const a = (i / rays) * Math.PI * 2; return <line key={i} x1={Math.cos(a) * 170} y1={Math.sin(a) * 170} x2={Math.cos(a) * 520} y2={Math.sin(a) * 520} />; })}
    </motion.svg>
    <motion.div className="sun-dome" initial={{ y: "70%" }} animate={{ y: `${(1 - rise) * 18}%` }} transition={{ type: "spring", stiffness: 40, damping: 16, delay: .2 }}>{children}</motion.div>
  </div>;
}

export function Sparkle({ size = 34, className = "" }: { size?: number; className?: string }) {
  return <motion.svg className={`sparkle ${className}`} width={size} height={size} viewBox="-10 -10 20 20" animate={{ rotate: [0, 90] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut", repeatType: "reverse" }} aria-hidden>
    <path d="M0 -10 C1 -2 2 -1 10 0 C2 1 1 2 0 10 C-1 2 -2 1 -10 0 C-2 -1 -1 -2 0 -10Z" />
  </motion.svg>;
}

export function Hatch({ className = "" }: { className?: string }) {
  return <div className={`hatch ${className}`} aria-hidden><div /></div>;
}

const GLYPHS = "01░▒▓/\\#*+=-<>";
/** Scrambles into place on mount and on hover — the wodniack mono label move. */
export function Scramble({ text, className = "" }: { text: string; className?: string }) {
  const [out, setOut] = useState(text);
  const timer = useRef<number | null>(null);
  const run = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    if (reduce()) { setOut(text); return; }
    let f = 0; const total = 14;
    timer.current = window.setInterval(() => {
      f++;
      setOut(text.split("").map((ch, i) => (ch === " " || f / total > i / text.length + 0.25 ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join(""));
      if (f >= total + text.length) { if (timer.current !== null) window.clearInterval(timer.current); timer.current = null; setOut(text); }
    }, 28);
  };
  useEffect(() => { run(); return () => { if (timer.current !== null) window.clearInterval(timer.current); }; }, [text]);
  return <span className={`scramble ${className}`} aria-label={text} onMouseEnter={run}><span aria-hidden="true">{out}</span></span>;
}

/** Giant headline: letters punch up from below and stretch back to size. */
export function BigTitle({ text, className = "poster-word" }: { text: string; className?: string }) {
  return <div className={className} aria-hidden="true">
    {Array.from(text).map((ch, i) => <span key={i} className="poster-word-cell" aria-hidden>
      <motion.span className="poster-word-ch" initial={{ y: "110%", scaleY: 2.4 }} animate={{ y: "0%", scaleY: 1 }}
        transition={{ type: "spring", stiffness: 160, damping: 17, delay: 0.12 + i * 0.07 }}
        whileHover={{ scaleY: 1.18, transition: { type: "spring", stiffness: 500, damping: 12 } }}>{ch}</motion.span>
    </span>)}
  </div>;
}

/** Count up to a number when it appears. */
export function CountUp({ to, decimals = 0, className = "" }: { to: number; decimals?: number; className?: string }) {
  const [v, setV] = useState(0);
  useEffect(() => { if (reduce()) { setV(to); return; } const t0 = performance.now(); let raf = 0; const step = (n: number) => { const k = Math.min(1, (n - t0) / 1100); setV(to * (1 - Math.pow(1 - k, 4))); if (k < 1) raf = requestAnimationFrame(step); }; raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf); }, [to]);
  return <span className={className}>{v.toFixed(decimals)}</span>;
}

/** Panel that tilts toward the pointer and casts a hard offset shadow. */
export function Tilt({ children, className = "", strength = 6 }: { children: ReactNode; className?: string; strength?: number }) {
  const mx = useMotionValue(0), my = useMotionValue(0);
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [strength, -strength]), { stiffness: 200, damping: 20 });
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-strength, strength]), { stiffness: 200, damping: 20 });
  return <motion.div className={`tilt ${className}`} style={{ rotateX: rx, rotateY: ry, transformPerspective: 1200 }}
    onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); mx.set((e.clientX - r.left) / r.width - 0.5); my.set((e.clientY - r.top) / r.height - 0.5); }}
    onPointerLeave={() => { mx.set(0); my.set(0); }}>{children}</motion.div>;
}

/** Cursor: a lagging ring and a star; grows over interactive things. */
export function Cursor() {
  const x = useMotionValue(-100), y = useMotionValue(-100);
  const sx = useSpring(x, { stiffness: 500, damping: 40 }), sy = useSpring(y, { stiffness: 500, damping: 40 });
  const [mode, setMode] = useState<"idle" | "hot" | "drag">("idle");
  useEffect(() => {
    const move = (e: PointerEvent) => { x.set(e.clientX); y.set(e.clientY); const el = (e.target as Element | null)?.closest?.("[data-cursor], button, a, input, textarea"); setMode(el?.getAttribute("data-cursor") === "drag" ? "drag" : el ? "hot" : "idle"); };
    addEventListener("pointermove", move); return () => removeEventListener("pointermove", move);
  }, [x, y]);
  if (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches) return null;
  return <>
    <motion.div className={`cursor-ring ${mode}`} style={{ x: sx, y: sy }} aria-hidden>{mode === "drag" && <span>拖动</span>}</motion.div>
    <motion.div className="cursor-dot" style={{ x, y }} aria-hidden />
  </>;
}

/** Rolling digits: each changed character slides in from below. */
export function Rolling({ value, className = "rolling" }: { value: string; className?: string }) {
  return <span className={className} aria-label={value}>
    {value.split("").map((ch, i) => <span key={i} className={`digit ${/[0-9]/.test(ch) ? "" : "sep"}`} aria-hidden="true">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={ch} initial={{ y: "100%" }} animate={{ y: "0%" }} exit={{ y: "-100%" }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}>{ch}</motion.span>
      </AnimatePresence>
    </span>)}
  </span>;
}

/**
 * The poster masthead every workspace opens with: a giant word, the page's
 * real heading set in serif, an optional mono meta line, and a wave field
 * that bends around the pointer. `tools` sit at the bottom right.
 */
export function PosterHeader({ word, heading, sub, meta, tools, className = "", headingLevel = 1 }: { word: string; heading: string; sub?: ReactNode; meta?: string; tools?: ReactNode; className?: string; headingLevel?: 1 | 2 }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return <header className={`poster-header ${className}`}>
    <Waves lines={34} amp={0.9} />
    <BigTitle text={word} />
    <div className="poster-aside">
      <Heading className="poster-heading">{heading}</Heading>
      {sub && <small className="poster-sub">{sub}</small>}
      {meta && <div className="poster-meta"><Sparkle size={18} /><Scramble text={meta} /></div>}
    </div>
    {tools && <div className="poster-tools">{tools}</div>}
  </header>;
}

/** Giant word + wave field, dropped into an existing header to make it a poster masthead. */
export function PosterMark({ word }: { word: string }) {
  return <>
    <Waves lines={34} amp={0.9} />
    <BigTitle text={word} />
  </>;
}
