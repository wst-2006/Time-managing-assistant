import { useEffect, useRef } from "react";

/**
 * The focus window's room: a one-point perspective tunnel behind the timer.
 * The back wall frames the element matched by `anchor` (title + digits);
 * rectangular frames recede from the window edge to that wall and drift
 * toward the viewer as time passes, so the room reads as moving forward
 * through time. The pointer nudges the vanishing point (parallax), and a
 * change of `rushKey` sends the room rushing forward (LET'S BEGIN).
 */
export function FocusRoom({ anchor, tone, speed = 0.06, rushKey = 0 }: {
  anchor: string;
  tone: "red" | "black";
  /** frames per second drifting toward the viewer */
  speed?: number;
  rushKey?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ tone, speed, rush: 0, travel: 0, px: 0, py: 0, tx: 0, ty: 0 });
  live.current.tone = tone;
  live.current.speed = speed;

  useEffect(() => { if (rushKey) live.current.rush = 1; }, [rushKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const room = canvas?.parentElement;
    const context = canvas?.getContext("2d");
    if (!canvas || !room || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let previous = performance.now();

    function onMove(event: PointerEvent) {
      const box = room!.getBoundingClientRect();
      live.current.tx = ((event.clientX - box.left) / box.width - 0.5) * 2;
      live.current.ty = ((event.clientY - box.top) / box.height - 0.5) * 2;
    }
    function onLeave() { live.current.tx = 0; live.current.ty = 0; }
    room.addEventListener("pointermove", onMove);
    room.addEventListener("pointerleave", onLeave);

    function draw(now: number) {
      const s = live.current;
      const dt = Math.min(64, now - previous) / 1000;
      previous = now;
      if (!reduced) {
        s.rush = Math.max(0, s.rush - dt / 1.4);
        s.travel = (s.travel + dt * (s.speed + 2.6 * s.rush * s.rush)) % 1;
        s.px += (s.tx - s.px) * Math.min(1, dt * 5);
        s.py += (s.ty - s.py) * Math.min(1, dt * 5);
      }
      const dpr = window.devicePixelRatio || 1;
      const width = canvas!.clientWidth, height = canvas!.clientHeight;
      if (canvas!.width !== Math.round(width * dpr) || canvas!.height !== Math.round(height * dpr)) {
        canvas!.width = Math.round(width * dpr);
        canvas!.height = Math.round(height * dpr);
      }
      const ctx = context!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const black = s.tone === "black";
      ctx.fillStyle = black ? "#120306" : "#ff1446";
      ctx.fillRect(0, 0, width, height);
      const line = black ? "255, 72, 102" : "22, 0, 0";

      const roomBox = canvas!.getBoundingClientRect();
      const target = room!.querySelector<HTMLElement>(anchor);
      const box = target?.getBoundingClientRect();
      // back wall, nudged against the pointer for parallax
      const shiftX = -s.px * 8, shiftY = -s.py * 6;
      const wall = box && box.width > 0
        ? { l: box.left - roomBox.left - 18 + shiftX, t: box.top - roomBox.top - 10 + shiftY, r: box.right - roomBox.left + 18 + shiftX, b: box.bottom - roomBox.top + 8 + shiftY }
        : { l: width * 0.2, t: height * 0.18, r: width * 0.8, b: height * 0.55 };
      const outer = { l: -2, t: -2, r: width + 2, b: height + 2 };
      const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
      const rect = (p: number) => ({ l: lerp(wall.l, outer.l, p), t: lerp(wall.t, outer.t, p), r: lerp(wall.r, outer.r, p), b: lerp(wall.b, outer.b, p) });

      ctx.lineWidth = 1;
      // corner edges of the room
      ctx.strokeStyle = `rgba(${line}, ${black ? 0.55 : 0.6})`;
      ctx.beginPath();
      ctx.moveTo(wall.l, wall.t); ctx.lineTo(outer.l, outer.t);
      ctx.moveTo(wall.r, wall.t); ctx.lineTo(outer.r, outer.t);
      ctx.moveTo(wall.l, wall.b); ctx.lineTo(outer.l, outer.b);
      ctx.moveTo(wall.r, wall.b); ctx.lineTo(outer.r, outer.b);
      ctx.stroke();
      // floor rails running from the wall to the viewer
      ctx.strokeStyle = `rgba(${line}, ${black ? 0.26 : 0.3})`;
      ctx.beginPath();
      for (let i = 1; i < 8; i++) {
        const x0 = lerp(wall.l, wall.r, i / 8), x1 = lerp(outer.l, outer.r, i / 8);
        ctx.moveTo(x0, wall.b); ctx.lineTo(x1, outer.b);
        ctx.moveTo(x0, wall.t); ctx.lineTo(x1, outer.t);
      }
      ctx.stroke();
      // receding frames, drifting toward the viewer
      const count = 7;
      for (let i = 0; i < count; i++) {
        const p = Math.pow((i + s.travel) / count, 2.1);
        const r = rect(p);
        ctx.strokeStyle = `rgba(${line}, ${(black ? 0.5 : 0.55) * Math.min(1, p * 3.2)})`;
        ctx.strokeRect(r.l, r.t, r.r - r.l, r.b - r.t);
      }
      // the back wall itself
      ctx.strokeStyle = `rgba(${line}, ${black ? 0.7 : 0.8})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(wall.l, wall.t, wall.r - wall.l, wall.b - wall.t);
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      room.removeEventListener("pointermove", onMove);
      room.removeEventListener("pointerleave", onLeave);
    };
  }, [anchor]);

  return <canvas ref={canvasRef} className="focus-room" aria-hidden="true" />;
}
