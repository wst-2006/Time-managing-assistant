import { useEffect, useRef } from "react";

/**
 * The speed lines either side of the focus page timer, drawn exactly like the
 * earlier static version (19 lines a side from the frame edge, converging on
 * the digits, a band 1.5× the digit size tall), plus one interaction:
 * moving the pointer up or down over the timer box rolls the lines on both
 * sides in that direction, slowly, and they keep gliding a little before
 * settling — like pushing a knob forward with a thumb. Otherwise they are still.
 */
const LINES = 18;                 // intervals in the band (19 lines)
const STEP = 100 / LINES;         // spacing in band units (band is 0–100 tall)
const VANISH_X = 200;             // vanishing point, in units of the line run (0–100)

export function FocusRays({ anchor }: { anchor: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = canvas?.parentElement;
    const context = canvas?.getContext("2d");
    if (!canvas || !box || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motion = { offset: 0, velocity: 0, lastY: null as number | null };
    let frame = 0;
    let previous = performance.now();

    function onMove(event: PointerEvent) {
      if (motion.lastY !== null && !reduced) {
        const dy = event.clientY - motion.lastY;
        // band units per second; up moves the lines up
        motion.velocity = Math.max(-40, Math.min(40, motion.velocity + dy * 0.35));
      }
      motion.lastY = event.clientY;
    }
    function onLeave() { motion.lastY = null; }
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerleave", onLeave);

    function draw(now: number) {
      const dt = Math.min(64, now - previous) / 1000;
      previous = now;
      motion.offset += motion.velocity * dt;
      motion.velocity *= Math.exp(-dt * 1.8);
      if (Math.abs(motion.velocity) < 0.01) motion.velocity = 0;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas!.clientWidth, height = canvas!.clientHeight;
      if (canvas!.width !== Math.round(width * dpr) || canvas!.height !== Math.round(height * dpr)) {
        canvas!.width = Math.round(width * dpr);
        canvas!.height = Math.round(height * dpr);
      }
      const ctx = context!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const digits = box!.querySelector<HTMLElement>(anchor);
      if (digits && width > 0) {
        const area = canvas!.getBoundingClientRect();
        const rect = digits.getBoundingClientRect();
        const size = parseFloat(getComputedStyle(digits).fontSize) || 200;
        const bandHeight = size * 1.5;
        const bandTop = rect.top - area.top + rect.height / 2 - bandHeight / 2;
        const gap = size * 0.12;
        const runLeft = Math.max(0, rect.left - area.left - gap);       // frame edge → digits
        const runRight = Math.max(0, area.right - rect.right - gap);
        ctx.strokeStyle = getComputedStyle(canvas!).color;
        ctx.lineWidth = 1.2;
        const shift = ((motion.offset % STEP) + STEP) % STEP;
        for (let k = -1; k <= LINES + 1; k++) {
          const y = k * STEP + shift;                                // 0–100 down the band
          if (y < -STEP || y > 100 + STEP) continue;
          // lines rolling past the band edges fade in and out instead of popping
          const edge = Math.min(y, 100 - y);
          const alpha = Math.max(0, Math.min(1, (edge + STEP * 0.4) / STEP));
          if (alpha <= 0) continue;
          const off = Math.abs(y - 50) / 50;
          const end = 93 + 7 * off * off;                            // arc-shaped inner ends
          const endY = y + (50 - y) * (end / VANISH_X);
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          if (runLeft > 4) {
            ctx.moveTo(rect.left - area.left - gap - runLeft, bandTop + (y / 100) * bandHeight);
            ctx.lineTo(rect.left - area.left - gap - runLeft + (end / 100) * runLeft, bandTop + (endY / 100) * bandHeight);
          }
          if (runRight > 4) {
            ctx.moveTo(rect.right - area.left + gap + runRight, bandTop + (y / 100) * bandHeight);
            ctx.lineTo(rect.right - area.left + gap + runRight - (end / 100) * runRight, bandTop + (endY / 100) * bandHeight);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerleave", onLeave);
    };
  }, [anchor]);

  return <canvas ref={canvasRef} className="focus-rays" aria-hidden="true" />;
}
