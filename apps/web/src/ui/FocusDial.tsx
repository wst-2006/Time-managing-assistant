import { useEffect, useRef } from "react";

/**
 * The dial: tick lines fanning out on both sides of the timer, read as the
 * ticks of one large knob centred on the digits.
 *
 *  - it moves only when the pointer moves up or down over the timer box:
 *    both sides roll in the pointer's direction, slowly, and keep gliding a
 *    little after the pointer stops, like pushing a knob with a thumb
 *  - otherwise it stays still
 *
 * The digits never move; only the ticks do. Colour comes from CSS `color`.
 */
const NOTCH = (5.6 * Math.PI) / 180;      // angle between ticks
const SECTOR = (36 * Math.PI) / 180;      // ticks shown within ±36° of horizontal
const FADE = (9 * Math.PI) / 180;         // fade near the sector edges

export function FocusDial({ anchor, band = Infinity, className = "" }: {
  /** CSS selector of the element the knob is centred on (looked up inside the dial's parent, which is also where the pointer is read). */
  anchor: string;
  /** Keep ticks within this many half-heights of the digits, vertically. */
  band?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({ angle: 0, velocity: 0, lastY: null as number | null });
  const bandRef = useRef(band);
  bandRef.current = band;


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
      if (s.lastY !== null) {
        // Only vertical movement counts: moving up rolls both sides up together,
        // like pushing a knob forward with a thumb. It adds momentum, not position.
        const dy = event.clientY - s.lastY;
        s.velocity = Math.max(-0.45, Math.min(0.45, s.velocity + dy * 0.005));
      }
      s.lastY = event.clientY;
    }
    function onLeave() { state.current.lastY = null; }
    room.addEventListener("pointermove", onMove);
    room.addEventListener("pointerleave", onLeave);

    function draw(now: number) {
      const s = state.current;
      const dt = Math.min(64, now - previous) / 1000;
      previous = now;
      // flywheel: momentum carries on after the pointer stops and dies away slowly
      if (reduced) s.velocity = 0;
      s.angle += s.velocity * dt;
      s.velocity *= Math.exp(-dt * 1.6);
      if (Math.abs(s.velocity) < 0.0005) s.velocity = 0;

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
        for (const base of [0, Math.PI]) {
          // right side: +angle moves lines down; the left side is mirrored so both move together
          const offset = base === 0 ? s.angle : -s.angle;
          const phase = ((offset % NOTCH) + NOTCH) % NOTCH;
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
