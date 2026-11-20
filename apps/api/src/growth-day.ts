/** Pure per-day aggregation used by the growth page (tasks, focus, outcomes, feedback, review). */
import type { focusSessionSegmentRuns, focusSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { isTaskOutcomeCompleted } from "@personal-ai/domain/task";
import { indexFocusSecondsBySession, recordedFocusSeconds } from "./focus-accounting.js";

type TaskRow = typeof tasks.$inferSelect;
type FocusRow = typeof focusSessions.$inferSelect;
type FocusSegmentRunRow = typeof focusSessionSegmentRuns.$inferSelect;
type OutcomeRow = typeof taskOutcomes.$inferSelect;
type FeedbackRow = typeof taskFeedback.$inferSelect;

export type DailyStateTone = "quiet" | "steady" | "bright" | "strained";
export type DailyGrowthBreakdown = {
  execution: number;
  focus: number;
  satisfaction: number;
  review: number;
};

const radarDefinitions = [
  { key: "mainlineProgress", label: "主线推进", source: "system" },
  { key: "overallExecution", label: "总体执行", source: "system" },
  { key: "focusQuality", label: "专注质量", source: "system" },
  { key: "energyState", label: "精力状态", source: "user" },
  { key: "wellbeing", label: "身心维护", source: "user" },
  { key: "growthGain", label: "成长获得", source: "user" }
] as const;

function percentage(value: number, total: number) {
  return total ? Math.round(value / total * 100) : 0;
}

function stateTone(feedback: FeedbackRow[]): DailyStateTone {
  if (feedback.length === 0) return "quiet";
  const satisfied = feedback.filter((item) => item.satisfaction === "satisfied").length;
  const dissatisfied = feedback.filter((item) => item.satisfaction === "dissatisfied").length;
  if (dissatisfied / feedback.length >= 0.5) return "strained";
  if (satisfied / feedback.length >= 0.6 && dissatisfied / feedback.length <= 0.2) return "bright";
  return "steady";
}

function progressAverage(taskRows: TaskRow[], latestOutcomeByTask: Map<string, OutcomeRow>) {
  if (taskRows.length === 0) return 0;
  return Math.round(taskRows.reduce((sum, task) => sum + (latestOutcomeByTask.get(task.id)?.progressPercent ?? 0), 0) / taskRows.length);
}

function startedWithinScheduledWindow(task: TaskRow, sessionRows: FocusRow[]) {
  if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) return false;
  const startAt = task.startAt;
  const endAt = task.endAt;
  return sessionRows.some((session) => {
    if (!session.startedAt || !["running", "paused", "ended", "evaluated"].includes(session.state)) return false;
    return session.startedAt >= startAt && session.startedAt < endAt;
  });
}

function dailyGrowthBreakdown(overallExecution: number, focusMinutes: number, feedback: FeedbackRow[], hasReview: boolean): DailyGrowthBreakdown {
  const satisfactionAverage = feedback.length
    ? feedback.reduce((sum, item) => sum + (item.satisfaction === "satisfied" ? 100 : item.satisfaction === "neutral" ? 60 : 20), 0) / feedback.length
    : 0;
  return {
    execution: Math.round(overallExecution / 100 * 45),
    focus: Math.min(25, Math.round(focusMinutes / 180 * 25)),
    satisfaction: Math.round(satisfactionAverage / 100 * 20),
    review: hasReview ? 10 : 0
  };
}

export function buildDayData(taskRows: TaskRow[], sessions: FocusRow[], outcomes: OutcomeRow[], feedback: FeedbackRow[], hasReview: boolean, segmentRuns: FocusSegmentRunRow[] = []) {
  const formalTaskRows = taskRows.filter((task) => task.recordKind !== "backfill");
  const formalTaskIds = new Set(formalTaskRows.map((task) => task.id));
  const formalSessions = sessions.filter((session) => formalTaskIds.has(session.taskId));
  const formalOutcomes = outcomes.filter((outcome) => formalTaskIds.has(outcome.taskId));
  const formalFeedback = feedback.filter((item) => formalTaskIds.has(item.taskId));
  const focusSecondsBySession = indexFocusSecondsBySession(segmentRuns);
  const focusByTask = new Map<string, { rawSeconds: number; effectiveSeconds: number }>();
  for (const session of formalSessions) {
    const current = focusByTask.get(session.taskId) ?? { rawSeconds: 0, effectiveSeconds: 0 };
    current.rawSeconds += session.rawActiveSeconds;
    current.effectiveSeconds += recordedFocusSeconds(session, focusSecondsBySession);
    focusByTask.set(session.taskId, current);
  }
  const latestOutcomeByTask = new Map<string, OutcomeRow>();
  for (const outcome of outcomes) {
    const previous = latestOutcomeByTask.get(outcome.taskId);
    if (!previous || outcome.recordedAt > previous.recordedAt) latestOutcomeByTask.set(outcome.taskId, outcome);
  }
  const latestFeedbackByTask = new Map<string, FeedbackRow>();
  for (const item of feedback) {
    const previous = latestFeedbackByTask.get(item.taskId);
    if (!previous || item.createdAt > previous.createdAt) latestFeedbackByTask.set(item.taskId, item);
  }
  const closedTasks = formalTaskRows.filter((task) => task.lifecycleStatus === "closed").length;
  const plannedTaskRows = formalTaskRows.filter((task) => task.lifecycleStatus !== "cancelled");
  const plannedTasks = plannedTaskRows.length;
  const rawFocusSeconds = formalSessions.reduce((sum, session) => sum + session.rawActiveSeconds, 0);
  const effectiveFocusSeconds = formalSessions.reduce((sum, session) => sum + recordedFocusSeconds(session, focusSecondsBySession), 0);
  const latestFormalFeedback = [...latestFeedbackByTask.entries()]
    .filter(([taskId]) => formalTaskIds.has(taskId))
    .map(([, item]) => item);
  const satisfaction = {
    satisfied: latestFormalFeedback.filter((item) => item.satisfaction === "satisfied").length,
    neutral: latestFormalFeedback.filter((item) => item.satisfaction === "neutral").length,
    dissatisfied: latestFormalFeedback.filter((item) => item.satisfaction === "dissatisfied").length
  };
  const latestFormalOutcomes = [...latestOutcomeByTask.entries()].filter(([taskId]) => formalTaskIds.has(taskId)).map(([, outcome]) => outcome);
  const latestOutcomes = latestFormalOutcomes;
  const outcomeCount = latestOutcomes.length;
  const completeCount = plannedTaskRows.filter((task) => {
    const latestOutcome = latestOutcomeByTask.get(task.id);
    if (latestOutcome) return isTaskOutcomeCompleted(latestOutcome.outcome);
    return startedWithinScheduledWindow(task, formalSessions.filter((session) => session.taskId === task.id));
  }).length;
  const quality = outcomeCount ? Math.round(latestOutcomes.reduce((sum, outcome) => sum + outcome.progressPercent, 0) / outcomeCount) : 0;
  const focusMinutes = Math.round(effectiveFocusSeconds / 60);
  const mainlineProgress = progressAverage(plannedTaskRows.filter((task) => task.sourceLongRangePlanId !== null), latestOutcomeByTask);
  const overallExecution = progressAverage(plannedTaskRows, latestOutcomeByTask);
  const feedbackScore = latestFormalFeedback.length
    ? Math.round(latestFormalFeedback.reduce((sum, item) => sum + (item.satisfaction === "satisfied" ? 100 : item.satisfaction === "neutral" ? 60 : 20), 0) / latestFormalFeedback.length)
    : rawFocusSeconds > 0 ? Math.min(100, percentage(effectiveFocusSeconds, rawFocusSeconds)) : 0;
  const radarValues = { mainlineProgress, overallExecution, focusQuality: feedbackScore, energyState: null, wellbeing: null, growthGain: null };
  const radar = radarDefinitions.map((definition) => ({ ...definition, value: radarValues[definition.key] }));
  const treeKind = quality >= 80 ? "常青树" : quality >= 45 ? "银杏" : outcomeCount > 0 ? "苔藓" : "种子";
  const pointsBreakdown = dailyGrowthBreakdown(overallExecution, focusMinutes, latestFormalFeedback, hasReview);
  const points = Object.values(pointsBreakdown).reduce((sum, value) => sum + value, 0);
  return {
    tasks: taskRows.map((task) => ({
      id: task.id, title: task.title, recordKind: task.recordKind ?? "formal", lifecycleStatus: task.lifecycleStatus, scheduleKind: task.scheduleKind,
      startAt: task.startAt, endAt: task.endAt, currentOutcome: task.currentOutcome,
      focusMinutes: Math.round((focusByTask.get(task.id)?.effectiveSeconds ?? 0) / 60),
      rawFocusMinutes: Math.round((focusByTask.get(task.id)?.rawSeconds ?? 0) / 60),
      latestOutcome: latestOutcomeByTask.get(task.id)?.outcome ?? null,
      startedWithinWindow: startedWithinScheduledWindow(task, formalSessions.filter((session) => session.taskId === task.id)),
      latestSatisfaction: latestFeedbackByTask.get(task.id)?.satisfaction ?? null,
      latestFeedbackNote: latestFeedbackByTask.get(task.id)?.note ?? null
    })),
    plannedTasks, closedTasks, completedTasks: completeCount, outcomeCount, completeCount,
    rawFocusMinutes: Math.round(rawFocusSeconds / 60), effectiveFocusMinutes: focusMinutes, satisfaction,
    radar, stateTone: stateTone(latestFormalFeedback),
    tree: { kind: treeKind, points, pointsBreakdown, growthPercent: Math.min(100, Math.round(focusMinutes / 90 * 100)), quality }
  };
}
