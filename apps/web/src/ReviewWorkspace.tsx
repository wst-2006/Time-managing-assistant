import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { RadarChart, type RadarValues } from "./ReviewRadar";
import { useShanghaiDate } from "./useShanghaiDate";
import { PosterMark } from "./ui/poster";

type Review = { id: string; localDate: string; state: string };
type RadarSnapshot = { id: string; reviewSessionId: string; radar: RadarValues; createdAt: string };
type Context = {
  tasks: Array<{ id: string; title: string; recordKind?: string; scheduleKind: "none" | "daypart" | "exact"; lifecycleStatus: string; currentOutcome: string | null; startAt: string | null; endAt: string | null }>;
  outcomes: Array<{ taskId: string; outcome: string; progressPercent: number }>;
  focusSessions: Array<{ id: string; taskId: string; rawActiveSeconds: number; effectiveFocusSeconds: number; state: string; startedAt?: string | null }>;
  feedback: Array<{ taskId: string; satisfaction: string }>;
};
const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
async function request<T>(path: string, method = "GET", body?: Record<string, unknown>): Promise<T> { const response = await fetch(`${API}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "review_request_failed"); return await response.json() as T; }
const chineseDigits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function chineseNumber(value: number) { if (value < 10) return chineseDigits[value] ?? String(value); if (value < 20) return `十${value === 10 ? "" : chineseDigits[value % 10]}`; if (value < 100) return `${chineseDigits[Math.floor(value / 10)]}十${value % 10 === 0 ? "" : chineseDigits[value % 10]}`; return String(value); }
function reviewDateLabel(value: string) { const date = new Date(`${value}T12:00:00+08:00`); const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(date); return `${chineseNumber(Number(value.slice(5, 7)))}月${chineseNumber(Number(value.slice(8, 10)))} · ${weekday}`; }
function isIsoDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/u.test(value); }
function shiftDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.UTC(year, month - 1, day + days, 12)));
}
function timeLabel(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "未排期"; }
function outcomeLabel(outcome: string | null | undefined, progress?: number) { if (outcome === "complete") return "完成"; if (outcome === "partial") return `部分完成${progress === undefined ? "" : ` · ${progress}%`}`; if (outcome === "not_completed") return "未完成"; return "未记录结果"; }
function satisfactionLabel(value: string | null | undefined) { if (value === "satisfied") return "满意"; if (value === "neutral") return "一般"; if (value === "dissatisfied") return "不满意"; return "未评价"; }

/** 复盘: the day's numbers, what happened to each task, and the saved six-axis snapshot. */
export function ReviewWorkspace({ onOpenGrowth }: { isWorkspaceCurrent?: boolean; onOpenGrowth?: () => void }) {
  const todayDate = useShanghaiDate();
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [review, setReview] = useState<Review | null>(null);
  const [radarSnapshot, setRadarSnapshot] = useState<RadarSnapshot | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const previousTodayDateRef = useRef(todayDate);
  useEffect(() => {
    const previous = previousTodayDateRef.current;
    previousTodayDateRef.current = todayDate;
    if (previous === todayDate) return;
    setSelectedDate((current) => current === previous ? todayDate : current);
  }, [todayDate]);
  const load = useCallback(async (date: string) => {
    const requestId = ++loadRequestRef.current;
    const data = await request<{ session: Review; radarSnapshot: RadarSnapshot | null; context: Context }>(`/api/v1/reviews/${date}`);
    if (requestId !== loadRequestRef.current) return;
    setReview(data.session); setRadarSnapshot(data.radarSnapshot); setContext(data.context);
  }, []);
  useEffect(() => {
    if (!isIsoDate(selectedDate)) return;
    setError(null); setReview(null); setRadarSnapshot(null); setContext(null);
    const requestId = loadRequestRef.current + 1;
    void load(selectedDate).catch(() => { if (requestId === loadRequestRef.current) setError("无法加载这一天的复盘，请确认软件后台正在运行。"); });
  }, [load, selectedDate]);
  const viewingToday = selectedDate === todayDate;
  const plannedTaskCount = useMemo(() => context?.tasks.filter((task) => task.recordKind !== "backfill" && task.lifecycleStatus !== "cancelled").length ?? 0, [context]); const effective = useMemo(() => Math.round((context?.focusSessions.reduce((sum, session) => sum + session.effectiveFocusSeconds, 0) ?? 0) / 60), [context]); const completed = useMemo(() => context?.tasks.filter((task) => {
    if (task.currentOutcome === "complete" || task.currentOutcome === "partial") return true;
    if (task.currentOutcome === "not_completed" || task.scheduleKind !== "exact" || !task.startAt || !task.endAt) return false;
    const startAt = task.startAt;
    const endAt = task.endAt;
    return Boolean(startAt && endAt && context.focusSessions.some((session) => session.taskId === task.id && session.startedAt && new Date(session.startedAt).getTime() >= new Date(startAt).getTime() && new Date(session.startedAt).getTime() < new Date(endAt).getTime()));
  }).length ?? 0, [context]);
  const taskSummaries = useMemo(() => {
    if (!context) return [];
    const now = Date.now();
    return context.tasks.flatMap((task) => {
      if (task.recordKind === "backfill" || task.scheduleKind !== "exact" || !task.startAt || !task.endAt || task.lifecycleStatus === "cancelled") return [];
      const outcome = [...context.outcomes].reverse().find((item) => item.taskId === task.id);
      const feedback = [...context.feedback].reverse().find((item) => item.taskId === task.id);
      const taskFocusSessions = context.focusSessions.filter((item) => item.taskId === task.id);
      const focusSeconds = taskFocusSessions.reduce((sum, item) => sum + item.effectiveFocusSeconds, 0);
      const startedWithinWindow = Boolean(task.startAt && task.endAt && taskFocusSessions.some((session) => session.startedAt && new Date(session.startedAt).getTime() >= new Date(task.startAt!).getTime() && new Date(session.startedAt).getTime() < new Date(task.endAt!).getTime()));
      const hasFinishedRecord = task.lifecycleStatus === "awaiting_outcome" || task.lifecycleStatus === "closed" || Boolean(outcome) || taskFocusSessions.some((item) => item.state === "ended" && (item.rawActiveSeconds > 0 || item.effectiveFocusSeconds > 0));
      if (new Date(task.endAt).getTime() > now && !hasFinishedRecord) return [];
      return [{ ...task, outcome, feedback, focusSeconds, startedWithinWindow }];
    });
  }, [context]);

  return <section className="page review-page" aria-labelledby="review-title">
    <header className="review-heading page-head poster-header"><PosterMark word="复盘" /><div><p className="eyebrow">{viewingToday ? "今晚复盘" : "历史复盘"}</p><h1 id="review-title">{viewingToday ? "把今天还给自己。" : "把这一天留给自己。"}</h1></div><div className="review-date-controls"><button className="quiet-button review-date-step" type="button" aria-label="前一天" title="前一天" onClick={() => setSelectedDate(shiftDate(selectedDate, -1))}><ChevronLeft /></button><label><span>查看日期</span><input aria-label="复盘日期" type="date" max={todayDate} value={selectedDate} onChange={(event) => { const nextDate = event.target.value; if (isIsoDate(nextDate)) setSelectedDate(nextDate); }} /></label><button className="quiet-button review-date-step" type="button" aria-label="后一天" title="后一天" disabled={selectedDate >= todayDate} onClick={() => setSelectedDate(shiftDate(selectedDate, 1))}><ChevronRight /></button>{!viewingToday && <button className="quiet-button" type="button" onClick={() => setSelectedDate(todayDate)}>回到今天</button>}</div></header>
    <section className="review-colophon" aria-label="这一天的数字"><time dateTime={review?.localDate ?? selectedDate}>{reviewDateLabel(review?.localDate ?? selectedDate)}</time><dl className="review-colophon-metrics"><div className="review-completion-mark"><dt>完成</dt><dd>{completed}<small>/{plannedTaskCount}</small></dd></div><div><dt>计划</dt><dd>{plannedTaskCount}<small>项</small></dd></div><div><dt>有效专注</dt><dd>{effective}m</dd></div><div><dt>六维</dt><dd>{radarSnapshot ? "已打分" : "未打分"}</dd></div></dl></section>
    <div className="review-board">
      <div className="review-main-column">
    <section className="review-task-summary review-sheet" aria-labelledby="review-task-summary-title"><div className="review-section-heading"><div><h2 id="review-task-summary-title">{viewingToday ? "今天发生了什么" : "这一天发生了什么"}</h2></div><span>{taskSummaries.length} 项任务</span></div>{taskSummaries.length ? <div className="review-task-summary-list">{taskSummaries.map((task) => <article key={task.id}><div><strong>{task.title}</strong><small>{timeLabel(task.startAt)} – {timeLabel(task.endAt)}</small></div><p><b>做了什么：</b>{task.title}<br /><b>完成情况：</b>{outcomeLabel(task.outcome?.outcome ?? task.currentOutcome ?? (task.startedWithinWindow ? "complete" : null), task.outcome?.progressPercent)} · 有效专注 {Math.round(task.focusSeconds / 60)} 分钟<br /><b>最后反馈：</b>{satisfactionLabel(task.feedback?.satisfaction)}</p></article>)}</div> : <p className="review-radar-empty">{viewingToday ? "今天还没有可复盘的正式任务。" : "这一天还没有可复盘的正式任务。"}</p>}</section>
      </div>
      <aside className="review-side-column" aria-label={viewingToday ? "今日六维" : "这一天的六维"}>
        <section className="review-radar-archive" aria-labelledby="review-radar-title"><div className="review-radar-archive-heading"><div><h2 id="review-radar-title">{viewingToday ? "今日六维" : "这一天的六维"}</h2></div><span>{radarSnapshot ? "已保存" : "尚未保存"}</span></div>{radarSnapshot ? <div className="review-radar-snapshot"><RadarChart compact values={radarSnapshot.radar} ariaLabel={viewingToday ? "今日六维回看快照" : "历史六维回看快照"} /><div className="review-radar-snapshot-copy"><strong>{viewingToday ? "今日体验快照" : "这一天的体验快照"}</strong><p>这张图来自你最后一次确认的六维评分，会固定保留在这一天的复盘里。</p></div></div> : <p className="review-radar-empty">{viewingToday ? "今天还没有保存六维体验。" : "这一天还没有保存六维体验。"}</p>}</section>
        {viewingToday && onOpenGrowth && <button className="primary-button review-radar-cta" type="button" onClick={onOpenGrowth}>{radarSnapshot ? "去成长页调整六维" : "去成长页给今天打分"}</button>}
      </aside>
    </div>
    {error && <div className="focus-error" role="alert">{error}</div>}
  </section>;
}
