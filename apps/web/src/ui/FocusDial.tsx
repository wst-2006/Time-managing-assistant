import { useEffect, useRef } from "react";

/**
 * The dial: tick lines fanning out on both sides of the timer, read as the
 * ticks of one large knob centred on the digits.
 *
 *  - time turns it: one notch every second while `ticking`
 *  - the pointer turns it: moving over the room rotates the knob, with a
 *    little inertia, like dragging a real dial
 *  - `spinKey` changes give it a quick spin (LET'S BEGIN)
 *
 * The digits never move; only the ticks do. Colour comes from CSS `color`.
 */
const NOTCH = (5.6 * Math.PI) / 180;      // angle between ticks
const SECTOR = (36 * Math.PI) / 180;      // ticks shown within ±36° of horizontal
const FADE = (9 * Math.PI) / 180;         // fade near the sector edges

export function FocusDial({ anchor, ticking = false, spinKey = 0, band = Infinity, className = "" }: {
  /** CSS selector of the element the knob is centred on (looked up inside the dial's parent). */
  anchor: string;
  ticking?: boolean;
  spinKey?: number;
  /** Keep ticks within this many half-heights of the digits, vertically. */
  band?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({ angle: 0, target: 0, velocity: 0, lastSecond: -1, lastY: null as number | null, lastX: null as number | null });
  const tickingRef = useRef(ticking);
  tickingRef.current = ticking;
  const bandRef = useRef(band);
  bandRef.current = band;

  useEffect(() => {
    if (spinKey) state.current.target += NOTCH * 48;
  }, [spinKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    // The pointer turns the dial anywhere in its room (the nearest [data-dial-room], else the parent).
    const room = canvas?.closest<HTMLElement>("[data-dial-room]") ?? canvas?.parentElement;
    if (!canvas || !room) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let previous = performance.now();

    function onMove(event: PointerEvent) {
      const s = state.current;
      if (s.lastY !== null && s.lastX !== null) {
        const box = canvas!.getBoundingClientRect();
        // Right half: moving down turns the knob clockwise; left half the opposite, like a real dial.
        const side = event.clientX - box.left > box.width / 2 ? 1 : -1;
        s.target += ((event.clientY - s.lastY) * side - (event.clientX - s.lastX) * 0.25) * 0.0042;
      }
      s.lastY = event.clientY;
      s.lastX = event.clientX;
    }
    function onLeave() { state.current.lastY = null; state.current.lastX = null; }
    room.addEventListener("pointermove", onMove);
    room.addEventListener("pointerleave", onLeave);

    function draw(now: number) {
      const s = state.current;
      const dt = Math.min(64, now - previous) / 1000;
      previous = now;
      // one notch per second while the clock runs
      const second = Math.floor(Date.now() / 1000);
      if (tickingRef.current && second !== s.lastSecond) {
        if (s.lastSecond !== -1) s.target += NOTCH;
        s.lastSecond = second;
      }
      // critically damped follow: no overshoot, settles in ~0.35s
      if (reduced) { s.angle = s.target; s.velocity = 0; }
      else {
        const k = 90, c = 2 * Math.sqrt(k);
        const acceleration = k * (s.target - s.angle) - c * s.velocity;
        s.velocity += acceleration * dt;
        s.angle += s.velocity * dt;
      }

      const dpr = window.devicePixelRatio || 1;
      const width = canvas!.clientWidth, height = canvas!.clientHeight;
      if (canvas!.width !== Math.round(width * dpr) || canvas!.height !== Math.round(height * dpr)) {
        canvas!.width = Math.round(width * dpr);
        canvas!.height = Math.round(height * dpr);
      }
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);
      context!.clearRect(0, 0, width, height);
      const target = room!.querySelector<HTMLElement>(anchor);
      if (target && width > 0) {
        const roomBox = canvas!.getBoundingClientRect();
        const box = target.getBoundingClientRect();
        const cx = box.left - roomBox.left + box.width / 2;
        const cy = box.top - roomBox.top + box.height / 2;
        const hw = box.width / 2 + Math.max(10, box.height * 0.06);
        const hh = box.height / 2;
        context!.strokeStyle = getComputedStyle(canvas!).color;
        context!.lineWidth = 1.2;
        const phase = ((s.angle % NOTCH) + NOTCH) % NOTCH;
        for (const base of [0, Math.PI]) {
          for (let a = -SECTOR - NOTCH + phase; a <= SECTOR; a += NOTCH) {
            const edge = SECTOR - Math.abs(a);
            if (edge < 0) continue;
            const theta = base + a;
            const cos = Math.cos(theta), sin = Math.sin(theta);
            const inner = Math.min(hw / Math.max(1e-6, Math.abs(cos)), hh / Math.max(1e-6, Math.abs(sin)));
            const outerX = (cos > 0 ? width - cx : cx) / Math.max(1e-6, Math.abs(cos));
            const outerY = (sin > 0 ? height - cy : cy) / Math.max(1e-6, Math.abs(sin));
            const outerBand = (hh * bandRef.current) / Math.max(1e-6, Math.abs(sin));
            const outer = Math.min(outerX, outerY, outerBand) - 2;
            if (outer <= inner + 4) continue;
            context!.globalAlpha = Math.min(1, edge / FADE);
            context!.beginPath();
            context!.moveTo(cx + cos * inner, cy + sin * inner);
            context!.lineTo(cx + cos * outer, cy + sin * outer);
            context!.stroke();
          }
        }
        context!.globalAlpha = 1;
      }
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      room.removeEventListener("pointermove", onMove);
      room.removeEventListener("pointerleave", onLeave);
    };
  }, [anchor]);

  return <canvas ref={canvasRef} className={`focus-dial ${className}`} aria-hidden="true" />;
}
