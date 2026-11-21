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

export function playLetsBegin(from: DOMRect, caption?: string) {
  if (typeof document === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const finish = () => { root.unmount(); host.remove(); };
  root.render(<LetsBegin origin={{ x: from.left + from.width / 2, y: from.top + from.height / 2, size: from.width }} caption={caption} onDone={finish} />);
}

/** Round GO button: an ink disc that floods outward when pressed. */
export function GoButton({ label, caption, onClick, className = "", disabled, ...rest }: { label: string; caption?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
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
      if (disc && !disabled) playLetsBegin(disc, caption);
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
