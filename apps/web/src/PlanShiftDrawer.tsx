import { CalendarClock, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { inferPlanInstructionDate, parsePlanShiftOffset } from "@personal-ai/domain/task";

type Adjustment = {
  taskId: string;
  title: string;
  expectedVersion: number;
  expectedScheduleRevision: number;
  currentStartAt: string;
  currentEndAt: string;
  nextStartAt: string;
  nextEndAt: string;
};
type Skipped = { taskId: string; title: string; reason: string };
type Preview = { localDate: string; offsetMinutes: number; adjustments: Adjustment[]; skipped: Skipped[] };
type ApiFailure = { error?: string; conflicts?: Array<{ title?: string }> };

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function range(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function scopeLabel(localDate: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date(`${localDate}T00:00:00+08:00`));
}

export function PlanShiftDrawer({ initialText, onDone }: { initialText?: string; onDone: () => void }) {
  const [text, setText] = useState(initialText ?? "");
  const [date, setDate] = useState(() => inferPlanInstructionDate(initialText ?? "", shanghaiDate()) ?? "");
  const [dateWasEdited, setDateWasEdited] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function buildPreview() {
    const offsetMinutes = parsePlanShiftOffset(text);
    if (!offsetMinutes) { setError("请写清楚顺延多久，例如“计划：把今天的任务整体顺延 30 分钟”。"); return; }
    if (!date) { setError("请选择明确的作用日期，批量调整不会跨多个日期执行。"); return; }
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${API}/api/v1/tasks/bulk-shift/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localDate: date, offsetMinutes }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "preview_failed");
      const next = payload as Preview;
      setPreview(next);
      setSelectedIds(defaultSelectedTaskIds(text, next.adjustments));
    } catch { setError("暂时无法读取当天排期，请确认本地服务正在运行。原话仍保留。"); }
    finally { setLoading(false); }
  }

  async function apply() {
    if (!preview || selectedIds.length === 0) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch(`${API}/api/v1/tasks/bulk-shift`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localDate: preview.localDate, offsetMinutes: preview.offsetMinutes, adjustments: preview.adjustments.filter((item) => selectedIds.includes(item.taskId)).map(({ taskId, expectedVersion, expectedScheduleRevision }) => ({ taskId, expectedVersion, expectedScheduleRevision })) }) });
      const payload = await response.json().catch(() => ({})) as ApiFailure;
      if (!response.ok) {
        if (payload.error === "task_time_conflict") {
          const titles = payload.conflicts?.map((item) => item.title).filter(Boolean).slice(0, 3).join("、");
          setError(`顺延后会与${titles ? `“${titles}”` : "其他任务"}重叠，排期没有改动。请调整作用日期或先处理冲突任务。`);
        } else if (payload.error === "task_version_conflict" || payload.error === "task_schedule_revision_conflict" || payload.error === "bulk_shift_invalid") {
          setError("预览后任务状态发生了变化，排期没有改动。请重新生成预览再确认。");
        } else {
          setError("保存没有完成，排期保持原样；请重新读取预览后再确认。");
        }
        return;
      }
      onDone();
    } catch { setError("保存没有完成，排期保持原样；请确认本地服务正在运行后重试。"); }
    finally { setSaving(false); }
  }

  return <section className="plan-shift-drawer" aria-labelledby="plan-shift-title">
    <div className="plan-change-intro"><span className="plan-change-icon"><CalendarClock /></span><div><p className="section-kicker">计划调整</p><h2 id="plan-shift-title">批量顺延，但先让你确认。</h2></div></div>
    <p className="plan-change-task">以“计划：”或“计划 ”开头的内容会进入这里，不会被当成新任务。只移动仍可编辑的精确排期。</p>
    <label className="plan-change-message"><span>调整说明</span><textarea aria-label="计划调整说明" value={text} onChange={(event) => { const nextText = event.target.value; setText(nextText); if (!dateWasEdited) setDate(inferPlanInstructionDate(nextText, shanghaiDate()) ?? ""); setPreview(null); }} rows={3} maxLength={4000} placeholder="计划：把今天的任务整体顺延 30 分钟" /></label>
    <label className="plan-shift-date"><span>作用日期</span><input required type="date" value={date} onChange={(event) => { setDateWasEdited(true); setDate(event.target.value); setPreview(null); setSelectedIds([]); }} /></label>
    <button className="primary-button full-width" type="button" disabled={loading || !text.trim()} onClick={() => void buildPreview()}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}{loading ? "正在读取排期" : "生成调整预览"}</button>
    {error && <p className="plan-change-error" role="alert"><X />{error}</p>}
    {preview && <section className="plan-shift-preview" aria-live="polite"><p className="plan-shift-summary">范围：{scopeLabel(preview.localDate)}。将{preview.offsetMinutes > 0 ? "顺延" : "提前"} {Math.abs(preview.offsetMinutes)} 分钟，已选择 {selectedIds.length} 项。</p>{preview.adjustments.length > 0 && <ul>{preview.adjustments.map((item) => <li key={item.taskId}><label><input type="checkbox" checked={selectedIds.includes(item.taskId)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, item.taskId] : current.filter((id) => id !== item.taskId))} /><span><strong>{item.title}</strong><small>{range(item.currentStartAt)}–{range(item.currentEndAt)} → {range(item.nextStartAt)}–{range(item.nextEndAt)}</small></span></label></li>)}</ul>}{preview.skipped.length > 0 && <div className="plan-shift-skipped"><strong>不会移动</strong>{preview.skipped.map((item) => <p key={item.taskId}>{item.title}：{item.reason}</p>)}</div>}<button className="primary-button full-width" type="button" disabled={saving || selectedIds.length === 0} onClick={() => void apply()}>{saving ? <LoaderCircle className="spin" /> : <Check />}{saving ? "正在保存" : `确认执行：${preview.offsetMinutes > 0 ? "顺延" : "提前"} ${selectedIds.length} 项`}</button></section>}
  </section>;
}

function defaultSelectedTaskIds(text: string, adjustments: Adjustment[]): string[] {
  const normalized = normalizePlanText(text);
  let eligible = adjustments;
  const afterMinute = planShiftAfterMinute(text);
  if (afterMinute !== null) {
    eligible = eligible.filter((item) => minuteOf(item.currentStartAt) >= afterMinute);
  }
  if (/(?:所有|全部|整体|全都)/u.test(normalized)) return eligible.map((item) => item.taskId);
  const subject = text.match(/把\s*(.+?)\s*(?:都\s*)?(?:往后|向后|顺延|推后|提前|往前|前移)/u)?.[1]
    ?.replace(/^(?:今天|今日|明天|后天|\d{4}-\d{2}-\d{2})(?:的)?/u, "")
    .trim();
  if (!subject) return [];
  const fragments = subject.split(/[、，,和与及]/u).map(normalizePlanText).filter(Boolean);
  const ids = new Set<string>();
  for (const fragment of fragments) {
    const matches = eligible.filter((item) => normalizePlanText(item.title).includes(fragment) || fragment.includes(normalizePlanText(item.title)));
    if (matches.length === 1) ids.add(matches[0]!.taskId);
  }
  return eligible.filter((item) => ids.has(item.taskId)).map((item) => item.taskId);
}

function normalizePlanText(value: string): string {
  return value.replace(/[\s：:。！？!?；;“”"']/gu, "");
}

function planShiftAfterMinute(value: string): number | null {
  const match = value.match(/(?:(上午|下午|晚上)\s*)?(\d{1,2})(?:[:：点时]\s*(\d{1,2})?\s*分?)?\s*(?:以后|之后|起)/u);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  if ((match[1] === "下午" || match[1] === "晚上") && hour < 12) hour += 12;
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function minuteOf(value: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(value));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60
    + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}
