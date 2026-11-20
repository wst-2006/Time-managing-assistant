import { buildApp } from "./app.js";
import { TaskService } from "./task-service.js";
import { MemoryTaskStore } from "./testing/memory-task-store.js";
import { afterAll, describe, expect, it } from "vitest";

const store = new MemoryTaskStore();
const app = buildApp({ taskService: new TaskService(store) });

afterAll(async () => {
  await app.close();
});

function elapsedHalfHour() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const nowMinute = (Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const startMinute = Math.max(7 * 60, Math.min(22 * 60 + 30, Math.floor(nowMinute / 30) * 30));
  const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return { start: hhmm(startMinute), end: hhmm(startMinute + 30) };
}

describe("health endpoint", () => {
  it("reports the API service as available", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "time-managing-assistant-api" });
  });

  it("allows the Tauri desktop origin to call the local API", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://tauri.localhost" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
  });
});

describe("task endpoints", () => {
  it("creates and lists a day task", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "整理本周计划",
        scheduleKind: "none",
        localDate: "2026-07-27"
      }
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().task.lifecycleStatus).toBe("open");

    const list = await app.inject({ method: "GET", url: "/api/v1/tasks?date=2026-07-27" });
    expect(list.statusCode).toBe(200);
    expect(list.json().tasks).toHaveLength(1);
  });

  it("rejects an empty task title", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { title: "", scheduleKind: "none" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects exact tasks outside the shared 30-minute contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "Off-grid task",
        scheduleKind: "exact",
        startAt: "2026-07-27T09:15:00+08:00",
        endAt: "2026-07-27T10:15:00+08:00",
        timeZone: "Asia/Shanghai"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_task");
  });

  it("rejects retired task metadata instead of silently persisting it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { title: "旧字段不应进入任务", scheduleKind: "none", plannedEffortMinutes: 30 }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_task");
  });

  it("rejects the current and already elapsed half-hour window for today's exact tasks", async () => {
    const interval = elapsedHalfHour();
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        title: "当前时间段不应创建",
        scheduleKind: "exact",
        startAt: `${date}T${interval.start}:00+08:00`,
        endAt: `${date}T${interval.end}:00+08:00`,
        timeZone: "Asia/Shanghai"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("task_schedule_window_unavailable");
  });

  it("allows the same elapsed interval through the explicit same-day backfill route", async () => {
    const interval = elapsedHalfHour();
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/backfill",
      payload: {
        title: "补录今天已经完成的事项",
        scheduleKind: "exact",
        startAt: `${date}T${interval.start}:00+08:00`,
        endAt: `${date}T${interval.end}:00+08:00`,
        timeZone: "Asia/Shanghai"
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { task: { id: string; version: number; recordKind: string; lifecycleStatus: string; scheduleKind: string }; historicalOverlaps: unknown[] };
    const created = body.task;
    expect(created).toMatchObject({ recordKind: "backfill", lifecycleStatus: "awaiting_outcome", scheduleKind: "exact" });
    expect(body.historicalOverlaps).toEqual([]);
    expect(store.reminderJobs.some((job) => job.taskId === created.id)).toBe(false);

    const outcome = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${created.id}/outcomes`,
      payload: {
        expectedVersion: created.version,
        outcome: "partial",
        progressPercent: 60,
        source: "app",
        satisfaction: "neutral",
        note: "当天补录结果"
      }
    });
    expect(outcome.statusCode).toBe(201);
    expect(outcome.json()).toMatchObject({
      task: { lifecycleStatus: "closed", currentOutcome: "partial" },
      outcome: { outcome: "partial", progressPercent: 60 },
      feedback: { satisfaction: "neutral", note: "当天补录结果" }
    });
    expect(store.outcomes.filter((item) => item.taskId === created.id)).toHaveLength(1);
    expect(store.feedback.filter((item) => item.taskId === created.id)).toHaveLength(1);
  });

  it("rejects exact scheduling before 07:00 and after 23:00", async () => {
    for (const [startAt, endAt] of [
      ["2099-01-05T06:30:00+08:00", "2099-01-05T07:30:00+08:00"],
      ["2099-01-05T22:30:00+08:00", "2099-01-05T23:30:00+08:00"]
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: { title: "超出可排时段", scheduleKind: "exact", startAt, endAt, timeZone: "Asia/Shanghai" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("task_schedule_outside_allowed_hours");
    }
  });
});



