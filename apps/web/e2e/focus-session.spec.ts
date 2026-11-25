import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connectE2EDatabase } from "./support/database";
import {
  desktopCommandRequests,
  focusSessionOperations,
  focusSessionSegmentRuns,
  focusSessions,
  focusStructureSegments,
  focusStructures,
  focusTimerJobs,
  reminderJobs,
  taskConflictAcceptances,
  taskFeedback,
  taskLegacyMetadata,
  taskLifecycleEvents,
  taskOutcomes,
  tasks,
} from "@personal-ai/db/schema";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { FocusTimerWorker } from "../../worker/src/focus-worker.js";
import { ReminderWorker } from "../../worker/src/worker-core.js";
import { OverdueTaskWorker } from "../../worker/src/overdue-task-worker.js";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

async function cleanup(_request:APIRequestContext, id:string) {
  const { client, db } = await connectE2EDatabase();
  try {
    const sessionRows = await db.select({ id: focusSessions.id }).from(focusSessions).where(eq(focusSessions.taskId, id));
    const structureRows = await db.select({ id: focusStructures.id }).from(focusStructures).where(eq(focusStructures.taskId, id));
    const sessionIds = sessionRows.map((row) => row.id);
    const structureIds = structureRows.map((row) => row.id);
    await db.delete(taskFeedback).where(eq(taskFeedback.taskId, id));
    await db.delete(taskOutcomes).where(eq(taskOutcomes.taskId, id));
    if (sessionIds.length > 0) {
      await db.delete(focusSessionOperations).where(inArray(focusSessionOperations.focusSessionId, sessionIds));
      await db.delete(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionIds));
      await db.delete(focusTimerJobs).where(inArray(focusTimerJobs.focusSessionId, sessionIds));
      await db.delete(focusSessions).where(inArray(focusSessions.id, sessionIds));
    }
    if (structureIds.length > 0) {
      await db.delete(focusStructureSegments).where(inArray(focusStructureSegments.focusStructureId, structureIds));
      await db.delete(focusStructures).where(inArray(focusStructures.id, structureIds));
    }
    await db.delete(reminderJobs).where(eq(reminderJobs.taskId, id));
    await db.delete(desktopCommandRequests).where(eq(desktopCommandRequests.taskId, id));
    await db.delete(taskConflictAcceptances).where(or(eq(taskConflictAcceptances.taskIdLow, id), eq(taskConflictAcceptances.taskIdHigh, id)));
    await db.delete(taskLegacyMetadata).where(eq(taskLegacyMetadata.taskId, id));
    await db.delete(taskLifecycleEvents).where(eq(taskLifecycleEvents.taskId, id));
    await db.delete(tasks).where(eq(tasks.id, id));
  } finally {
    await client.end();
  }
}

async function expirePreparation(id: string) {
  const { client, db } = await connectE2EDatabase();
  try {
    await db.update(focusSessions).set({ preparingEndsAt: new Date(Date.now() - 1_000) }).where(eq(focusSessions.id, id));
    await db.update(focusTimerJobs).set({ dueAt: new Date(Date.now() - 1_000) }).where(and(
      eq(focusTimerJobs.focusSessionId, id),
      eq(focusTimerJobs.kind, "preparation_complete"),
      eq(focusTimerJobs.status, "pending")
    ));
  } finally {
    await client.end();
  }
}

async function runFocusWorker(now: Date, sessionId?: string, kind?: "preparation_start" | "preparation_complete" | "confirmation_timeout" | "segment_transition") {
  const { client, db } = await connectE2EDatabase();
  try {
    const worker = new FocusTimerWorker(db);
    return await worker.processNext(now, sessionId && kind ? { focusSessionId: sessionId, kind } : undefined);
  } finally {
    await client.end();
  }
}

async function makeSegmentTransitionDue(sessionId: string, now: Date) {
  const { client, db } = await connectE2EDatabase();
  try {
    await db.update(focusTimerJobs).set({ dueAt: now }).where(and(
      eq(focusTimerJobs.focusSessionId, sessionId),
      eq(focusTimerJobs.kind, "segment_transition"),
      eq(focusTimerJobs.status, "pending")
    ));
  } finally {
    await client.end();
  }
}

async function createStructureEditorTask() {
  const date = new Date(Date.now() + 86_400_000);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const id = randomUUID();
  const title = `E2E 结构编辑器 ${Date.now().toString(36)}`;
  const { client, db } = await connectE2EDatabase();
  try {
    await db.insert(tasks).values({
      id,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate,
      startAt: new Date(`${localDate}T09:00:00+08:00`),
      endAt: new Date(`${localDate}T12:00:00+08:00`),
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
  } finally {
    await client.end();
  }
  return { id, title, localDate };
}

async function createLateStartTask() {
  const halfHour = 30 * 60_000;
  const base = new Date(Math.floor(Date.now() / halfHour) * halfHour);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(base);
  const taskId = randomUUID();
  const structureId = randomUUID();
  const title = `E2E 晚开始 ${Date.now().toString(36)}`;
  const startAt = new Date(base.getTime() - 90 * 60_000);
  const endAt = new Date(startAt.getTime() + 120 * 60_000);
  const { client, db } = await connectE2EDatabase();
  try {
    await db.insert(tasks).values({
      id: taskId,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate,
      startAt,
      endAt,
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await db.insert(focusStructures).values({
      id: structureId,
      taskId,
      taskScheduleRevision: 1,
      state: "active",
      source: "manual",
      mode: "segmented",
      version: 1,
      totalStartAt: startAt,
      totalEndAt: endAt,
      confirmedAt: new Date()
    });
    await db.insert(focusStructureSegments).values([
      { id: randomUUID(), focusStructureId: structureId, position: 0, segmentType: "focus", durationMinutes: 55 },
      { id: randomUUID(), focusStructureId: structureId, position: 1, segmentType: "break", durationMinutes: 5 },
      { id: randomUUID(), focusStructureId: structureId, position: 2, segmentType: "focus", durationMinutes: 55 },
      { id: randomUUID(), focusStructureId: structureId, position: 3, segmentType: "break", durationMinutes: 5 }
    ]);
  } finally {
    await client.end();
  }
  return { taskId, title, startAt, endAt };
}

async function createUnstructuredRunningTask() {
  const now = new Date();
  const startAt = new Date(now);
  startAt.setMinutes(now.getMinutes() < 30 ? 0 : 30, 0, 0);
  const endAt = new Date(startAt.getTime() + 60 * 60_000);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(startAt);
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const title = `E2E 无结构倒计时 ${Date.now().toString(36)}`;
  const { client, db } = await connectE2EDatabase();
  try {
    await db.insert(tasks).values({
      id: taskId,
      title,
      lifecycleStatus: "active",
      scheduleKind: "exact",
      localDate,
      startAt,
      endAt,
      timeZone: "Asia/Shanghai",
      version: 2,
      scheduleRevision: 1
    });
    await db.insert(focusSessions).values({
      id: sessionId,
      taskId,
      state: "running",
      plannedStartAt: startAt,
      plannedEndAt: endAt,
      startedAt: new Date(now.getTime() - 60_000),
      activeSinceAt: new Date(now.getTime() - 60_000),
      version: 1
    });
  } finally {
    await client.end();
  }
  return { taskId, title };
}

async function createCurrentExactTask(title: string) {
  const now = new Date();
  const alignedNow = new Date(Math.floor(now.getTime() / (30 * 60_000)) * (30 * 60_000));
  const startAt = new Date(alignedNow.getTime() - 30 * 60_000);
  const endAt = new Date(alignedNow.getTime() + 60 * 60_000);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  const id = randomUUID();
  const structureId = randomUUID();
  const { client, db } = await connectE2EDatabase();
  try {
    await db.insert(tasks).values({
      id,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate,
      startAt,
      endAt,
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await db.insert(focusStructures).values({
      id: structureId,
      taskId: id,
      taskScheduleRevision: 1,
      state: "active",
      source: "manual",
      mode: "continuous",
      version: 1,
      totalStartAt: startAt,
      totalEndAt: endAt,
      confirmedAt: new Date()
    });
    await db.insert(focusStructureSegments).values([
      { id: randomUUID(), focusStructureId: structureId, position: 0, segmentType: "focus", durationMinutes: 80 },
      { id: randomUUID(), focusStructureId: structureId, position: 1, segmentType: "break", durationMinutes: 10 }
    ]);
  } finally {
    await client.end();
  }
  return {
    id,
    version: 1,
    scheduleRevision: 1,
    localDate,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString()
  };
}

function clockTextToSeconds(value: string): number {
  return value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

async function cleanupStructureEditorTask(id: string) {
  const { client, db } = await connectE2EDatabase();
  try {
    const structures = await db.select({ id: focusStructures.id }).from(focusStructures).where(eq(focusStructures.taskId, id));
    for (const structure of structures) {
      await db.delete(focusStructureSegments).where(eq(focusStructureSegments.focusStructureId, structure.id));
    }
    await db.delete(focusStructures).where(eq(focusStructures.taskId, id));
    await db.delete(tasks).where(eq(tasks.id, id));
  } finally {
    await client.end();
  }
}

async function openTaskStructureEditor(page: Page, title: string, localDate: string) {
  await page.getByLabel("时间轴日期").fill(localDate);
  await page.waitForLoadState("networkidle");
  const morningTimeline = page.getByRole("button", { name: "查看上午时间轴", exact: true });
  if (await morningTimeline.count()) await morningTimeline.click();
  const task = page.locator(`[data-task-id]`).filter({ hasText: title });
  await expect(task).toBeVisible();
  await task.getByRole("button", { name: `打开 ${title} 的任务操作` }).click();
  await page.getByRole("button", { name: "我会准时开始", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel("专注结构编辑器")).toBeVisible();
}

test("没有可选任务时专注页只显示空心 00:00，没有横条和开始按钮", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2099-12-20T10:00:00+08:00"));
  await page.goto("/");
  await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();

  await expect(page.locator(".ink-clepsydra strong.empty")).toHaveText("00:00");
  await expect(page.locator(".ink-clepsydra-line")).toBeHidden();
  await expect(page.locator(".focus-main-action")).toHaveCount(0);
  await expect(page.locator(".flip-clock,.focus-timer,.focus-orbit,.focus-themed-timer")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "选一件任务开始专注" })).toBeVisible();
});

test("没有执行中会话时可打开 30 分钟待专注任务而不会触发整页错误", async ({ page }) => {
  const localDate = "2099-12-20";
  const taskId = "00000000-0000-4000-8000-000000000030";
  const task = {
    id: taskId,
    title: "30 分钟待专注任务",
    recordKind: "formal",
    lifecycleStatus: "open",
    scheduleKind: "exact",
    startAt: `${localDate}T09:00:00+08:00`,
    endAt: `${localDate}T09:30:00+08:00`,
    timeZone: "Asia/Shanghai",
    scheduleRevision: 1,
    version: 1
  };
  await page.clock.setFixedTime(new Date(`${localDate}T08:00:00+08:00`));
  await page.route(`${apiBase}/api/v1/tasks?date=${localDate}`, (route) => route.fulfill({ json: {
    tasks: [task], blockingConflicts: [], historicalOverlaps: []
  } }));
  await page.route(`${apiBase}/api/v1/focus-sessions/current`, (route) => route.fulfill({ json: { session: null, snapshot: null } }));
  await page.route(`${apiBase}/api/v1/tasks/${taskId}/focus-structures`, (route) => route.fulfill({ json: { focusStructures: [] } }));

  await page.goto("/");
  await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();

  await expect(page.locator(".workspace-render-error")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
  await expect(page.getByLabel("专注结构编辑器")).toBeVisible();
  await expect(page.locator(".structure-timeline > .focus")).toContainText("25m");
  await expect(page.locator(".structure-timeline > .break")).toContainText("5m");
  await expect(page.getByRole("button", { name: "确认并使用", exact: true })).toBeEnabled();
});

test("未排期任务不会进入专注候选且服务端拒绝创建会话", async ({ page, request }) => {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const title = `E2E 未排期进度 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const created = await request.post(`${apiBase}/api/v1/tasks`, {
      data: { title, scheduleKind: "none", localDate: date, timeZone: "Asia/Shanghai" }
    });
    expect(created.status()).toBe(201);
    const task = ((await created.json()).task as { id: string; version: number });
    taskId = task.id;

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    const taskSlip = page.locator(".focus-task-slip").filter({ hasText: title });
    await expect(taskSlip).toHaveCount(0);
    await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
    await expect(page.locator(".ink-clepsydra strong.empty")).toHaveText("00:00");
    await expect.poll(() => page.locator(".ink-clepsydra").evaluate((element) => getComputedStyle(element).getPropertyValue("--ink-progress").trim())).toBe("0%");

    const rejected = await request.post(`${apiBase}/api/v1/focus-sessions`, {
      data: { taskId, expectedTaskVersion: task.version, mode: "prepare" }
    });
    expect(rejected.status()).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "focus_task_not_scheduled" });
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("真实专注会话在刷新后保持且不能暂停或提前结束",async({page,request})=>{
  test.setTimeout(120_000);
  const task = await createUnstructuredRunningTask();
  try {
    await page.goto("/");
    const focusNav=page.locator(".app-rail").getByRole("button",{name:"专注"}); await expect(focusNav).toHaveCount(1); await focusNav.click();
    await expect(page.getByRole("heading",{name:task.title})).toBeVisible();
    await expect(page.locator(".focus-stage")).toHaveClass(/focus-scene-focus/);
    await expect(page.getByText("专注进行中，不可暂停或提前结束", { exact: true })).toBeVisible();
    await expect(page.getByRole("button",{name:"暂停",exact:true})).toHaveCount(0);
    await expect(page.getByRole("button",{name:"结束并记录",exact:true})).toHaveCount(0);
    await expect(page.locator(".focus-structure-editor")).toHaveCount(0);
    await page.reload();
    const restoredFocusNav=page.locator(".app-rail").getByRole("button",{name:"专注"}); await expect(restoredFocusNav).toHaveCount(1); await restoredFocusNav.click();
    await expect(page.getByRole("heading",{name:task.title})).toBeVisible();
    await expect(page.getByText("专注进行中，不可暂停或提前结束", { exact: true })).toBeVisible();
    const current=await request.get(`${apiBase}/api/v1/focus-sessions/current-execution`);
    expect((await current.json()).session).toMatchObject({taskId:task.taskId,state:"running"});
  } finally { await cleanup(request,task.taskId); }
});

test("没有已确认结构的飞书启动会话仍按固定结束时间持续倒计时", async ({ page, request }) => {
  test.setTimeout(120_000);
  const task = await createUnstructuredRunningTask();
  try {
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
    await expect(page.locator(".focus-structure-editor")).toHaveCount(0);

    const clock = page.locator(".ink-clepsydra strong");
    const first = clockTextToSeconds(await clock.innerText());
    await page.waitForTimeout(1_200);
    const second = clockTextToSeconds(await clock.innerText());
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(0);
  } finally {
    await cleanup(request, task.taskId);
  }
});

test("准备与执行状态收起方法卡和配置器并在 390px 下不溢出", async ({ page, request }) => {
  test.setTimeout(120_000);
  const title = `阅读论文 E2E 提示 ${Date.now().toString(36)}`;
  let taskId = "";
  let aiCalls = 0;
  page.on("request", (outgoing) => {
    if (outgoing.url().includes("/api/v1/ai/")) aiCalls += 1;
  });
  try {
    const task = await createCurrentExactTask(title);
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "prepare" } });
    expect(started.status()).toBe(201);

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByLabel("本次专注提示")).toHaveCount(0);
    await expect(page.locator(".focus-structure-editor")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "我会准时开始", exact: true })).toBeVisible();

    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByLabel("本次专注提示")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByLabel("本次专注提示")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "我会准时开始", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(aiCalls).toBe(0);
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("1 分钟准备可手动确认并立即进入固定结束时间计时", async ({ page, request }) => {
  test.setTimeout(120_000);
  const title = `E2E 跳过准备 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const task = await createCurrentExactTask(title);
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "prepare" } });
    expect(started.status()).toBe(201);

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const skipped = page.waitForResponse((response) => response.url().endsWith("/skip-preparation") && response.status() === 200);
    await page.getByRole("button", { name: "我会准时开始", exact: true }).click();
    await skipped;
    await expect(page.getByText("专注进行中，不可暂停或提前结束", { exact: true })).toBeVisible();
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByText("专注进行中，不可暂停或提前结束", { exact: true })).toBeVisible();
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("390px 移动端可恢复真实专注会话并保持固定计时", async ({ page, request }) => {
  test.setTimeout(120_000);
  const title = `E2E 移动专注 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const task = await createCurrentExactTask(title);
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "prepare" } });
    expect(started.status()).toBe(201);
    const sessionId = ((await started.json()) as { session: { id: string } }).session.id;
    await expirePreparation(sessionId);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.locator(".mobile-nav").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("专注进行中，不可暂停或提前结束", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByText("专注进行中，不可暂停或提前结束", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});




test("准备倒计时结束后未确认会进入等待开始且不计入专注", async ({ page, request }) => {
  test.setTimeout(120_000);
  const title = `E2E 无响应提醒 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const task = await createCurrentExactTask(title);
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "remind" } });
    expect(started.status()).toBe(201);
    const session = (await started.json()).session as { id: string };
    const { client, db } = await connectE2EDatabase();
    try {
      await db.update(focusTimerJobs).set({ dueAt: new Date(Date.now() - 1_000) }).where(and(
        eq(focusTimerJobs.focusSessionId, session.id),
        eq(focusTimerJobs.kind, "confirmation_timeout"),
        eq(focusTimerJobs.status, "pending")
      ));
    } finally { await client.end(); }
    await runFocusWorker(new Date(), session.id, "confirmation_timeout");

    const detail = await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
    expect(detail.status()).toBe(200);
    const body = await detail.json() as { task: { lifecycleStatus: string; currentOutcome: string; scheduleRevision: number }; outcomes: Array<{ focusSessionId: string | null; outcome: string; source: string }> };
    expect(body.task).toMatchObject({ lifecycleStatus: "open", currentOutcome: null, scheduleRevision: 1 });
    expect(body.outcomes.some((outcome) => outcome.focusSessionId === session.id && outcome.source === "system")).toBe(false);

    const verification = await connectE2EDatabase();
    try {
      const [stored] = await verification.db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
      expect(stored).toMatchObject({ state: "awaiting_late_start", startedAt: null, activeSinceAt: null, rawActiveSeconds: 0, effectiveFocusSeconds: 0 });
    } finally {
      await verification.client.end();
    }

    const current = await request.get(`${apiBase}/api/v1/focus-sessions/current-execution`);
    expect(current.status()).toBe(200);
    expect((await current.json()).session).toMatchObject({ id: session.id, state: "awaiting_late_start" });
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注" }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("已错过原定开始时间；点击“现在开始计时”只记录实际时长", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "现在开始计时", exact: true })).toBeVisible();
  } finally { if (taskId) await cleanup(request, taskId); }
});

test("软件未打开时任务开始 5 分钟无响应仍由 Reminder Worker 持久化", async ({ request }) => {
  test.setTimeout(120_000);
  const taskId = randomUUID();
  const jobId = randomUUID();
  const title = `E2E 离线无响应 ${Date.now().toString(36)}`;
  const startAt = new Date("2026-08-06T09:00:00+08:00");
  const endAt = new Date("2026-08-06T10:00:00+08:00");
  const followUpAt = new Date(startAt.getTime() + 5 * 60_000);
  const connection = await connectE2EDatabase();
  try {
    const leftovers = await connection.db.select({ id: tasks.id }).from(tasks)
      .where(like(tasks.title, "E2E 离线无响应 %"));
    const leftoverIds = leftovers.map((item) => item.id).filter((id) => id !== taskId);
    if (leftoverIds.length > 0) {
      await connection.db.delete(reminderJobs).where(inArray(reminderJobs.taskId, leftoverIds));
      await connection.db.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(inArray(tasks.id, leftoverIds));
    }
    await connection.db.insert(tasks).values({
      id: taskId,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: "2026-08-06",
      startAt,
      endAt,
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1
    });
    await connection.db.insert(reminderJobs).values({
      id: jobId,
      taskId,
      channel: "feishu",
      kind: "task_follow_up",
      scheduleRevision: 1,
      status: "pending",
      scheduledAt: startAt,
      availableAt: new Date("2000-01-01T00:00:00.000Z"),
      attempts: 0,
      payload: {
        taskId,
        title,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timeZone: "Asia/Shanghai",
        scheduleRevision: 1
      }
    });
    const provider = { deliver: async () => { throw new Error("follow-up must not send another card"); } };
    const worker = new ReminderWorker(connection.db);
    await expect(worker.processNext(provider, followUpAt)).resolves.toBe("sent");
  } finally {
    await connection.client.end();
  }

  try {
    const detail = await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
    expect(detail.status()).toBe(200);
    const body = await detail.json() as {
      task: { lifecycleStatus: string; currentOutcome: string; scheduleRevision: number };
      outcomes: Array<{ focusSessionId: string | null; outcome: string; source: string }>;
      feedback: Array<{ focusSessionId: string | null; satisfaction: string }>;
    };
    expect(body.task).toMatchObject({ lifecycleStatus: "closed", currentOutcome: "not_completed", scheduleRevision: 2 });
    expect(body.outcomes.some((outcome) => outcome.focusSessionId && outcome.outcome === "not_completed" && outcome.source === "system")).toBe(true);
    expect(body.feedback.some((item) => item.focusSessionId && item.satisfaction === "dissatisfied")).toBe(true);
    const verification = await connectE2EDatabase();
    try {
      const [session] = await verification.db.select().from(focusSessions).where(eq(focusSessions.taskId, taskId));
      expect(session).toMatchObject({ state: "ended", rawActiveSeconds: 0, effectiveFocusSeconds: 0 });
    } finally {
      await verification.client.end();
    }
  } finally {
    await cleanup(request, taskId);
  }
});

test("开机补偿扫描会将无会话和仅确认但未运行的过期任务统一记为未完成", async ({ request }) => {
  const now = new Date("2026-09-07T12:00:00+08:00");
  const taskWithoutSession = randomUUID();
  const armedTask = randomUUID();
  const armedSession = randomUUID();
  const connection = await connectE2EDatabase();
  try {
    await connection.db.insert(tasks).values([
      {
        id: taskWithoutSession,
        title: `E2E 开机补偿无会话 ${Date.now().toString(36)}`,
        lifecycleStatus: "open",
        scheduleKind: "exact",
        localDate: "2026-09-07",
        startAt: new Date("2026-09-07T08:00:00+08:00"),
        endAt: new Date("2026-09-07T09:00:00+08:00"),
        timeZone: "Asia/Shanghai",
        version: 1,
        scheduleRevision: 1
      },
      {
        id: armedTask,
        title: `E2E 开机补偿已确认 ${Date.now().toString(36)}`,
        lifecycleStatus: "open",
        scheduleKind: "exact",
        localDate: "2026-09-07",
        startAt: new Date("2026-09-07T09:00:00+08:00"),
        endAt: new Date("2026-09-07T10:00:00+08:00"),
        timeZone: "Asia/Shanghai",
        version: 1,
        scheduleRevision: 1
      }
    ]);
    await connection.db.insert(focusSessions).values({
      id: armedSession,
      taskId: armedTask,
      state: "armed",
      plannedStartAt: new Date("2026-09-07T09:00:00+08:00"),
      plannedEndAt: new Date("2026-09-07T10:00:00+08:00"),
      version: 1
    });

    const worker = new OverdueTaskWorker(connection.db);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    await expect(worker.processNext(now)).resolves.toBe("completed");
    await expect(worker.processNext(now)).resolves.toBe("idle");
  } finally {
    await connection.client.end();
  }

  try {
    for (const taskId of [taskWithoutSession, armedTask]) {
      const detail = await request.get(`${apiBase}/api/v1/tasks/${taskId}`);
      expect(detail.status()).toBe(200);
      const body = await detail.json() as {
        task: { lifecycleStatus: string; currentOutcome: string; scheduleRevision: number };
        outcomes: Array<{ focusSessionId: string | null; outcome: string; source: string }>;
        feedback: Array<{ focusSessionId: string | null; satisfaction: string }>;
      };
      expect(body.task).toMatchObject({ lifecycleStatus: "closed", currentOutcome: "not_completed", scheduleRevision: 2 });
      expect(body.outcomes).toContainEqual(expect.objectContaining({ outcome: "not_completed", source: "system" }));
      expect(body.feedback).toContainEqual(expect.objectContaining({ satisfaction: "dissatisfied" }));
    }
    const verification = await connectE2EDatabase();
    try {
      const sessions = await verification.db.select().from(focusSessions)
        .where(inArray(focusSessions.taskId, [taskWithoutSession, armedTask]));
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.state === "ended" && session.startedAt === null && session.rawActiveSeconds === 0)).toBe(true);
    } finally {
      await verification.client.end();
    }
  } finally {
    await cleanup(request, taskWithoutSession);
    await cleanup(request, armedTask);
  }
});

test("真实结构执行会持久化段运行并自动切换到休息段", async ({ page, request }) => {
  test.setTimeout(120_000);
  const now = new Date();
  const halfHour = 30 * 60 * 1_000;
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const title = `E2E 分段结构 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    let startAt = new Date((Math.floor(now.getTime() / halfHour) + 1) * halfHour);
    let created = null as Awaited<ReturnType<typeof request.post>> | null;
    while (localDate.format(startAt) === localDate.format(now)) {
      const endAt = new Date(startAt.getTime() + 60 * 60_000);
      if (localDate.format(endAt) !== localDate.format(startAt)) break;
      const attempt = await request.post(`${apiBase}/api/v1/tasks`, { data: {
        title,
        scheduleKind: "exact",
        timeZone: "Asia/Shanghai",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        notes: "结构执行验收"
      } });
      if (attempt.status() === 201) {
        created = attempt;
        break;
      }
      const error = await attempt.json() as { error?: string };
      expect(error.error).toBe("task_time_conflict");
      startAt = new Date(startAt.getTime() + halfHour);
    }
    test.skip(!created, "当天没有可用的、不会跨午夜且不影响现有计划的 60 分钟精确任务窗口");
    expect(created).not.toBeNull();
    const task = (await created.json()).task as { id: string; version: number; scheduleRevision: number; startAt: string; endAt: string };
    taskId = task.id;

    const candidateResponse = await request.post(`${apiBase}/api/v1/focus-structures/candidates`, { data: {
      taskId,
      taskVersion: task.version,
      taskScheduleRevision: task.scheduleRevision,
      source: "manual",
      mode: "continuous",
      totalStartAt: task.startAt,
      totalEndAt: task.endAt,
      breakMinutes: 5
    } });
    expect(candidateResponse.status()).toBe(201);
    const candidate = (await candidateResponse.json()).focusStructure as { id: string; version: number };
    const confirmed = await request.post(`${apiBase}/api/v1/focus-structures/${candidate.id}/confirm`, { data: {
      expectedVersion: candidate.version,
      expectedTaskVersion: task.version,
      expectedTaskScheduleRevision: task.scheduleRevision
    } });
    expect(confirmed.status()).toBe(200);

    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: {
      taskId,
      expectedTaskVersion: task.version,
      mode: "prepare"
    } });
    expect(started.status()).toBe(201);
    const session = (await started.json()).session as { id: string; state: string };
    expect(session.state).toBe("scheduled");
    expect(await runFocusWorker(new Date(new Date(task.startAt).getTime() - 60_000), session.id, "preparation_start")).toBe("completed");
    await expirePreparation(session.id);
    const lateSnapshot = await request.get(`${apiBase}/api/v1/focus-sessions/current-execution`);
    expect(lateSnapshot.status()).toBe(200);
    expect((await lateSnapshot.json()).session).toMatchObject({ id: session.id, state: "awaiting_late_start" });
    const current = await request.get(`${apiBase}/api/v1/focus-sessions/tasks/${taskId}/current`);
    const currentSession = (await current.json()).session as { id: string; version: number };
    const confirmedStart = await request.post(`${apiBase}/api/v1/focus-sessions/${currentSession.id}/skip-preparation`, { data: { expectedVersion: currentSession.version } });
    expect(confirmedStart.status()).toBe(200);

    const { client, db } = await connectE2EDatabase();
    try {
      const current = (await db.select().from(focusSessions).where(eq(focusSessions.id, session.id)))[0];
      expect(current?.state).toBe("running");
      expect(current?.startedAt).not.toBeNull();
      expect(current?.activeSinceAt).not.toBeNull();
      expect(current?.currentSegmentPosition).toBe(0);
      const initialRuns = await db.select().from(focusSessionSegmentRuns)
        .where(eq(focusSessionSegmentRuns.focusSessionId, session.id));
      expect(initialRuns).toHaveLength(2);
      expect(initialRuns.find((run) => run.position === 0)?.startedAt).not.toBeNull();
    } finally {
      await client.end();
    }

  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});

test("晚开始按原结构当前位置继续并把过去段落记为跳过", async ({ page, request }) => {
  test.setTimeout(120_000);
  const task = await createLateStartTask();
  try {
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: {
      taskId: task.taskId,
      expectedTaskVersion: 1,
      mode: "prepare"
    } });
    expect(started.status()).toBe(201);
    const session = (await started.json()).session as { id: string; state: string };
    expect(session.state).toBe("preparing");
    const lateSnapshot = await request.get(`${apiBase}/api/v1/focus-sessions/current-execution`);
    expect(lateSnapshot.status()).toBe(200);
    expect((await lateSnapshot.json()).session).toMatchObject({ id: session.id, state: "awaiting_late_start" });

    const current = await request.get(`${apiBase}/api/v1/focus-sessions/tasks/${task.taskId}/current`);
    const currentSession = (await current.json()).session as { id: string; version: number; state: string };
    const confirmed = await request.post(`${apiBase}/api/v1/focus-sessions/${currentSession.id}/skip-preparation`, { data: { expectedVersion: currentSession.version } });
    expect(confirmed.status()).toBe(200);

    const { client, db } = await connectE2EDatabase();
    try {
      const [running] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
      expect(running?.state).toBe("running");
      expect(running?.startedAt).not.toBeNull();
      expect(running?.activeSinceAt).not.toBeNull();
      // The first two planned segments have already elapsed by confirmation;
      // they are skipped, while counted time begins at the explicit click.
      expect(running?.currentSegmentPosition).toBe(2);
      expect(running?.currentSegmentElapsedSeconds).toBeGreaterThanOrEqual(20 * 60);
      const runs = await db.select().from(focusSessionSegmentRuns).where(eq(focusSessionSegmentRuns.focusSessionId, session.id));
      expect(runs.find((run) => run.position === 0)).toMatchObject({ elapsedSeconds: 0, startedAt: null, completedAt: null });
      expect(runs.find((run) => run.position === 0)?.skippedAt).not.toBeNull();
      expect(runs.find((run) => run.position === 1)?.skippedAt).not.toBeNull();
      expect(runs.find((run) => run.position === 2)?.startedAt).not.toBeNull();
    } finally {
      await client.end();
    }

    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
    await expect(page.locator(".focus-execution-context > span")).toHaveText("正在专注");
    await expect(page.getByRole("button", { name: "查看专注安排", exact: true })).toBeVisible();
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.locator(".focus-execution-context > span")).toHaveText("正在专注");

    const boundary = new Date(task.startAt.getTime() + 115 * 60_000);
    await makeSegmentTransitionDue(session.id, boundary);
    expect(await runFocusWorker(boundary, session.id, "segment_transition")).toBe("completed");
    const verification = await connectE2EDatabase();
    try {
      const runs = await verification.db.select().from(focusSessionSegmentRuns)
        .where(eq(focusSessionSegmentRuns.focusSessionId, session.id));
      expect(runs.find((run) => run.position === 2)?.elapsedSeconds).toBe(35 * 60);
    } finally {
      await verification.client.end();
    }
  } finally {
    await cleanup(request, task.taskId);
  }
});

test("手动专注结构可直接确认，也可暂存候选后刷新恢复", async ({ page }) => {
  test.setTimeout(120_000);
  const task = await createStructureEditorTask();
  try {
    await page.goto("/");
    await openTaskStructureEditor(page, task.title, task.localDate);

    await page.getByRole("button", { name: "4 段", exact: true }).click();
    await page.getByRole("button", { name: "逐渐延长", exact: true }).click();
    await expect(page.locator(".structure-timeline > div")).toHaveCount(8);
    await expect(page.getByText("刚好填满任务时间", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "精确编辑", exact: true }).click();
    const firstFocus = page.getByLabel("第 1 段专注分钟");
    const firstBreak = page.getByLabel("第 1 段休息分钟");
    const focusBeforeDrag = Number(await firstFocus.inputValue());
    const breakBeforeDrag = Number(await firstBreak.inputValue());
    await firstFocus.fill(String(focusBeforeDrag - 5));
    await firstBreak.fill(String(breakBeforeDrag + 5));
    expect(Number(await firstFocus.inputValue())).toBeLessThan(focusBeforeDrag);
    expect(Number(await firstBreak.inputValue())).toBeGreaterThan(breakBeforeDrag);
    await expect(page.getByText("刚好填满任务时间", { exact: true })).toBeVisible();

    const directCandidate = page.waitForResponse((response) => response.url().endsWith("/api/v1/focus-structures/candidates") && response.request().method() === "POST" && response.status() === 201);
    const directConfirmation = page.waitForResponse((response) => response.url().includes("/api/v1/focus-structures/") && response.url().endsWith("/confirm") && response.status() === 200);
    await page.getByRole("button", { name: "确认并使用", exact: true }).click();
    await Promise.all([directCandidate, directConfirmation]);
    await expect(page.getByText("当前使用方案", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "已使用", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("正在使用");

    await page.getByRole("button", { name: "3 段", exact: true }).click();
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/v1/focus-structures/candidates") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "暂存候选", exact: true }).click();
    await saved;
    await expect(page.getByText("候选方案，等待确认", { exact: true })).toBeVisible();

    await page.reload();
    await openTaskStructureEditor(page, task.title, task.localDate);
    await expect(page.getByText("候选方案，等待确认", { exact: true })).toBeVisible();
    await expect(page.locator(".structure-timeline > div")).toHaveCount(6);

    const confirmed = page.waitForResponse((response) => response.url().includes("/api/v1/focus-structures/") && response.url().endsWith("/confirm") && response.status() === 200);
    await page.getByRole("button", { name: "确认并使用", exact: true }).click();
    await confirmed;
    await expect(page.getByText("当前使用方案", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "已使用", exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await openTaskStructureEditor(page, task.title, task.localDate);
    await expect(page.getByText("当前使用方案", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "精确编辑", exact: true }).click();
    await expect(page.getByLabel("第 1 段专注分钟")).toBeVisible();
    await page.getByLabel("第 1 段专注分钟").fill("30");
    await expect(page.getByText("各段总和必须刚好填满任务时间。", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await cleanupStructureEditorTask(task.id);
  }
});


test("按会话读取专注状态不会卡住后台（迷你窗点“我会准时开始”后会立即读取）", async ({ request }) => {
  test.setTimeout(60_000);
  const title = `E2E 会话快照 ${Date.now().toString(36)}`;
  let taskId = "";
  try {
    const task = await createCurrentExactTask(title);
    taskId = task.id;
    const started = await request.post(`${apiBase}/api/v1/focus-sessions`, { data: { taskId, expectedTaskVersion: task.version, mode: "prepare" } });
    expect(started.status()).toBe(201);
    const sessionId = ((await started.json()) as { session: { id: string } }).session.id;
    const snapshot = await request.get(`${apiBase}/api/v1/focus-sessions/${sessionId}/snapshot`, { timeout: 5_000 });
    expect(snapshot.status()).toBe(200);
    // the API must still answer afterwards
    expect((await request.get(`${apiBase}/health`, { timeout: 5_000 })).status()).toBe(200);
    expect((await request.get(`${apiBase}/api/v1/focus-sessions/current`, { timeout: 5_000 })).status()).toBe(200);
  } finally {
    if (taskId) await cleanup(request, taskId);
  }
});
