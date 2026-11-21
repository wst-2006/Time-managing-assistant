import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/**
 * Terminal grammar for the focus page and focus window: a prompt line that
 * states what is really happening, a segment ruler, the session agenda and a
 * status table. No fake window chrome, paths or binary rain.
 */

export function TerminalPrompt({ command, argument, flags, state }: { command: string; argument?: string | null; flags?: string | null; state?: ReactNode }) {
  return <div className="term-prompt" aria-hidden="true">
    <span className="term-prompt-line">
      <span className="term-caret">&gt;</span> {command}
      {argument ? <> <b>{argument}</b></> : null}
      {flags ? <> <span className="term-flags">{flags}</span></> : null}
      <i className="term-cursor" />
    </span>
    {state ? <span className="term-state">{state}</span> : null}
  </div>;
}

export type RulerSegment = { position: number; segmentType: "focus" | "break"; durationMinutes: number };

/** One block per segment, width by duration; the current block fills as it runs. */
export function SegmentRuler({ segments, currentPosition, progress }: { segments: RulerSegment[]; currentPosition: number | null; progress: number }) {
  if (!segments.length) return null;
  return <div className="term-ruler" role="img" aria-label={`共 ${segments.length} 段，当前第 ${(currentPosition ?? -1) + 1} 段`}>
    {segments.map((segment) => {
      const state = currentPosition === null || segment.position > currentPosition ? "next" : segment.position < currentPosition ? "done" : "current";
      return <div
        key={segment.position}
        className={`term-ruler-segment ${segment.segmentType} ${state}`}
        style={{ flexGrow: segment.durationMinutes, ["--fill" as string]: `${state === "done" ? 100 : state === "current" ? Math.round(progress) : 0}%` }}
      >
        <span>{String(segment.position + 1).padStart(2, "0")} {segment.segmentType === "break" ? "休" : "专注"} {segment.durationMinutes}′</span>
        {state === "current" ? <em>{Math.round(progress)}%</em> : null}
      </div>;
    })}
  </div>;
}

export type AgendaLine = { time: string; tag: string; text: string; state: "past" | "current" | "next" };

/** The session's agenda, read top to bottom like a log: past solid, now marked, later dim. */
export function SessionAgenda({ lines }: { lines: AgendaLine[] }) {
  if (!lines.length) return null;
  return <ol className="term-agenda" aria-label="本次安排">
    {lines.map((line, index) => <li key={`${line.time}-${index}`} className={line.state}>
      <span className="term-agenda-time">{line.time}</span>
      <span className="term-agenda-tag">{line.state === "current" ? "▸ " : ""}{line.tag}</span>
      <span>{line.text}</span>
    </li>)}
  </ol>;
}

export function SessionTable({ title, count, rows }: { title: string; count?: string; rows: Array<[string, string]> }) {
  return <section className="term-table" aria-label="当前专注状态">
    <header><span>{title}</span>{count ? <span>{count}</span> : null}</header>
    <dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}

const SLICE_BANDS = 6;

/**
 * Word swap in horizontal bands (the wodniack “LET’S ↔ ROCK” move): the word is
 * stacked several times, each copy clipped to one strip, and every strip rolls
 * to the new word a moment after the one above it.
 */
export function SliceText({ text, className = "" }: { text: string; className?: string }) {
  const [shown, setShown] = useState({ from: text, to: text, key: 0 });
  useEffect(() => {
    setShown((current) => current.to === text ? current : { from: current.to, to: text, key: current.key + 1 });
  }, [text]);
  const animating = shown.from !== shown.to;
  // The sizer holds the one real text node (transparent, it sets the width and is what
  // assistive tech and text search see); the bands draw copies via CSS so they add no text.
  return <span className={`slice-text ${animating ? "is-rolling" : ""} ${className}`}>
    <span className="slice-sizer">{shown.to}</span>
    {Array.from({ length: SLICE_BANDS }, (_, band) => <span
      key={`${shown.key}-${band}`}
      className={`slice-band ${animating ? "rolling" : ""}`}
      aria-hidden="true"
      style={{ ["--band" as string]: band, ["--bands" as string]: SLICE_BANDS }}
    >
      <span className="slice-roll"><span data-text={shown.from} /><span data-text={shown.to} /></span>
    </span>)}
  </span>;
}

/**
 * “LET'S BEGIN”: the GO disc travels to the centre and swells into a large ink
 * circle, the words swap LET'S → BEGIN in horizontal bands, then the circle
 * floods the screen and lifts away to reveal the running timer. It lives on
 * <body> so it keeps playing while the page underneath changes state.
 */
function LetsBegin({ origin, caption, onDone }: { origin: { x: number; y: number; size: number }; caption?: string; onDone: () => void }) {
  const [word, setWord] = useState("LET'S");
  useEffect(() => {
    const swap = window.setTimeout(() => setWord("BEGIN"), 820);
    const done = window.setTimeout(onDone, 2050);
    return () => { window.clearTimeout(swap); window.clearTimeout(done); };
  }, [onDone]);
  return <div className="lets-begin" aria-hidden="true" style={{
    ["--from-x" as string]: `${origin.x}px`,
    ["--from-y" as string]: `${origin.y}px`,
    ["--from-size" as string]: `${origin.size}px`
  }}>
    <div className="lets-begin-disc">
      <SliceText text={word} className="lets-begin-word" />
      {caption ? <span className="lets-begin-caption">{caption}</span> : null}
    </div>
  </div>;
}

/**
 * A short lens bulge on the page around a point, like the reference site's
 * hover distortion: an SVG displacement map pushes pixels outward from the
 * centre, swells for ~250ms and settles back within ~700ms.
 */
let lensMapUrl: string | null = null;
function lensMap(): string {
  if (lensMapUrl) return lensMapUrl;
  const size = 256, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x / (size - 1)) * 2 - 1, dy = (y / (size - 1)) * 2 - 1;
    const r = Math.hypot(dx, dy);
    const strength = r < 1 ? Math.sin(Math.PI * r) * (1 - r) : 0;
    const index = (y * size + x) * 4;
    image.data[index] = 128 - 127 * dx * strength;
    image.data[index + 1] = 128 - 127 * dy * strength;
    image.data[index + 2] = 128;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  lensMapUrl = canvas.toDataURL();
  return lensMapUrl;
}

export function playLens(target: HTMLElement | null, centreX: number, centreY: number, radius = 260) {
  if (!target || typeof document === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = target.getBoundingClientRect();
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  const id = `go-lens-${Date.now()}`;
  svg.innerHTML = `<filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${box.width}" height="${box.height}" color-interpolation-filters="sRGB">
    <feFlood flood-color="rgb(128,128,128)" result="neutral"/>
    <feImage href="${lensMap()}" x="${centreX - box.left - radius}" y="${centreY - box.top - radius}" width="${radius * 2}" height="${radius * 2}" preserveAspectRatio="none" result="bulge"/>
    <feComposite in="bulge" in2="neutral" operator="over" result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G"/>
  </filter>`;
  document.body.appendChild(svg);
  const displacement = svg.querySelector("feDisplacementMap");
  const previous = target.style.filter;
  target.style.filter = `url(#${id})`;
  const started = performance.now(), duration = 720;
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / duration);
    const swell = t < .35 ? Math.sin((t / .35) * Math.PI / 2) : Math.cos(((t - .35) / .65) * Math.PI / 2);
    displacement?.setAttribute("scale", String(70 * swell));
    if (t < 1) requestAnimationFrame(step);
    else { target.style.filter = previous; svg.remove(); }
  };
  requestAnimationFrame(step);
}

export function playLetsBegin(from: DOMRect, caption?: string) {
  if (typeof document === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const finish = () => { root.unmount(); host.remove(); };
  root.render(<LetsBegin origin={{ x: from.left + from.width / 2, y: from.top + from.height / 2, size: from.width }} caption={caption} onDone={finish} />);
  playLens(document.querySelector<HTMLElement>(".workspace-layer.current .focus-stage"), from.left + from.width / 2, from.top + from.height / 2);
}

/**
 * Focus-window version of LET'S BEGIN: the ink floods the whole window from the
 * GO button, LET'S swaps to BEGIN, and BEGIN swaps straight into the countdown,
 * so the opening runs into the timer instead of cutting to it.
 */
let lastLetsBeginAt = 0;
export const LETS_BEGIN_WINDOW_MS = 1750;

function LetsBeginFill({ origin, finalText, onDone }: { origin: { x: number; y: number }; finalText: () => string; onDone: () => void }) {
  const [word, setWord] = useState("LET'S");
  useEffect(() => {
    const begin = window.setTimeout(() => setWord("BEGIN"), 720);
    const digits = window.setTimeout(() => setWord(finalText()), 1260);
    const done = window.setTimeout(onDone, LETS_BEGIN_WINDOW_MS);
    return () => { window.clearTimeout(begin); window.clearTimeout(digits); window.clearTimeout(done); };
  }, [finalText, onDone]);
  const radius = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y));
  return <div className="lets-begin-fill" aria-hidden="true" style={{ ["--from-x" as string]: `${origin.x}px`, ["--from-y" as string]: `${origin.y}px`, ["--cover" as string]: `${radius * 2 + 4}px` }}>
    <span className="lets-begin-fill-disc" />
    <SliceText text={word} className="lets-begin-fill-word" />
  </div>;
}

/** Plays the window-filling LET'S BEGIN. `from` is the GO disc, or null to start from the centre. */
export function playLetsBeginInWindow(from: DOMRect | null, finalText: () => string) {
  if (typeof document === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (Date.now() - lastLetsBeginAt < 4000) return false;
  lastLetsBeginAt = Date.now();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const finish = () => { root.unmount(); host.remove(); };
  const origin = from ? { x: from.left + from.width / 2, y: from.top + from.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  root.render(<LetsBeginFill origin={origin} finalText={finalText} onDone={finish} />);
  return true;
}

/** Round GO button: an ink disc that floods outward when pressed. */
export function GoButton({ label, caption, fillWindow, onClick, className = "", disabled, ...rest }: { label: string; caption?: string; fillWindow?: () => string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [launching, setLaunching] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return <button
    {...rest}
    type="button"
    aria-label={label}
    disabled={disabled}
    className={`go-button ${launching ? "launching" : ""} ${className}`}
    onClick={(event) => {
      const disc = event.currentTarget.querySelector(".go-disc")?.getBoundingClientRect();
      if (disc && !disabled) {
        if (fillWindow) playLetsBeginInWindow(disc, fillWindow);
        else playLetsBegin(disc, caption);
      }
      setLaunching(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setLaunching(false), 700);
      onClick?.(event);
    }}
  >
    <span className="go-disc" aria-hidden="true"><span>GO</span></span>
    <span className="go-caption" aria-hidden="true">{label}</span>
  </button>;
}
