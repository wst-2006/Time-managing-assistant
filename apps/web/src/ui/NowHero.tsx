import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Rolling, Scramble, Sparkle, Sun, Tunnel } from "./poster";

type HeroTask = { id: string; title: string; startAt: string | null; endAt: string | null; lifecycleStatus: string };

const DAY_START = 7 * 60 * 60;
const DAY_END = 23 * 60 * 60;
const secondsFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function shanghaiSecondOfDay(ms: number) {
  const parts = secondsFormatter.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
}
const secondOf = (value: string | null) => value ? shanghaiSecondOfDay(new Date(value).getTime()) : 0;
const hhmm = (second: number) => `${String(Math.floor(second / 3600)).padStart(2, "0")}:${String(Math.floor(second / 60) % 60).padStart(2, "0")}`;
const duration = (second: number) => {
  const s = Math.max(0, Math.floor(second));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
};

/**
 * The 此刻 hero: a perspective tunnel and a sun whose height is how much of
 * the 07:00–23:00 day has gone. The sun is the button into focus for the
 * task that is running now, or the next one waiting.
 */
export function NowHero({ tasks, onStart }: { tasks: HeroTask[]; onStart: (taskId: string) => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const now = shanghaiSecondOfDay(nowMs);
  const candidates = tasks
    .filter((task) => task.startAt && task.endAt && (task.lifecycleStatus === "open" || task.lifecycleStatus === "active"))
    .sort((a, b) => secondOf(a.startAt) - secondOf(b.startAt));
  const running = candidates.find((task) => task.lifecycleStatus === "active")
    ?? candidates.find((task) => secondOf(task.startAt) <= now && now < secondOf(task.endAt));
  const next = candidates.find((task) => secondOf(task.startAt) > now);
  const task = running ?? next ?? null;
  const isRunning = !!running;
  const remaining = task ? (isRunning ? secondOf(task.endAt) - now : secondOf(task.startAt) - now) : 0;
  const rise = Math.max(0, Math.min(1, (now - DAY_START) / (DAY_END - DAY_START)));

  return <section className="now-hero" aria-label="此刻">
    <Tunnel horizon={0.8} />
    <div className="now-hero-copy">
      <div className="now-hero-kicker"><Sparkle size={14} /><Scramble text={!task ? "CLEAR / 暂无待开始" : isRunning ? "NOW / 正在进行" : "NEXT / 下一件"} /><Sparkle size={14} /></div>
      <AnimatePresence mode="wait">
        <motion.h2 key={task?.id ?? "none"} initial={{ y: 36, opacity: 0, scaleY: 1.6 }} animate={{ y: 0, opacity: 1, scaleY: 1 }} exit={{ y: -24, opacity: 0 }} transition={{ type: "spring", stiffness: 210, damping: 20 }}>
          {task?.title ?? "此刻没有排好的事"}
        </motion.h2>
      </AnimatePresence>
      {task
        ? <>
          <p>{hhmm(secondOf(task.startAt))}–{hhmm(secondOf(task.endAt))}，{isRunning ? "距离结束还有" : "距离开始还有"}</p>
          <Rolling className="rolling now-hero-count" value={duration(remaining)} />
        </>
        : <p>在下面的时间轴上拖一段空白，就能排进一件事。</p>}
    </div>
    <Sun rise={rise}>
      <motion.button type="button" className="now-hero-start" disabled={!task} aria-label={task ? `进入专注：${task.title}` : "暂无可开始的任务"} onClick={() => task && onStart(task.id)} whileHover={{ scale: 1.07 }} whileTap={{ scale: 0.93 }}>
        开始<small>{!task ? "先排一件事" : isRunning ? "进入专注" : "准时开始"}</small>
      </motion.button>
    </Sun>
  </section>;
}
