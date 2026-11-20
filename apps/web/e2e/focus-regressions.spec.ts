import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { tasks } from "@personal-ai/db/schema";
import { inArray } from "drizzle-orm";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

async function seedPendingEvaluations() {
  const rows = [
    { date: "2099-09-06", title: "回归待评价 9月6日", start: "09:00", end: "09:30" },
    { date: "2099-09-05", title: "回归待评价 9月5日", start: "10:00", end: "10:30" },
    { date: "2099-09-03", title: "回归待评价 9月3日", start: "11:00", end: "11:30" },
  ].map((row) => ({
    id: randomUUID(),
    title: row.title,
    lifecycleStatus: "awaiting_outcome" as const,
    scheduleKind: "exact" as const,
    localDate: row.date,
    startAt: new Date(`${row.date}T${row.start}:00+08:00`),
    endAt: new Date(`${row.date}T${row.end}:00+08:00`),
    timeZone: "Asia/Shanghai",
    version: 1,
    scheduleRevision: 1,
  }));
  const connection = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await connection.db.insert(tasks).values(rows);
  } finally {
    await connection.client.end();
  }
  return rows;
}

async function deleteTasks(ids: string[]) {
  const connection = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await connection.db.delete(tasks).where(inArray(tasks.id, ids));
  } finally {
    await connection.client.end();
  }
}

test("待评价列表跨日期读取全部任务并按日期从新到旧排列", async ({ page }) => {
  const rows = await seedPendingEvaluations();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "专注", exact: true }).click();
    const pending = page.locator(".focus-picker-section.pending .focus-task-slip");
    await expect(pending).toHaveCount(rows.length);
    await expect(pending.nth(0)).toContainText("回归待评价 9月6日");
    await expect(pending.nth(1)).toContainText("回归待评价 9月5日");
    await expect(pending.nth(2)).toContainText("回归待评价 9月3日");
    await expect(pending.nth(0)).toContainText("2099年9月6日");
    await expect(pending.nth(2)).toContainText("2099年9月3日");
  } finally {
    await deleteTasks(rows.map((row) => row.id));
  }
});

test("固定结束时间已过的任务既不显示为可开始，也被服务端拒绝启动", async ({ page, request }) => {
  const taskId = randomUUID();
  const date = "2026-09-06";
  const startAt = new Date(`${date}T08:00:00+08:00`);
  const endAt = new Date(`${date}T09:00:00+08:00`);
  const title = "回归已过期任务";
  const connection = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await connection.db.insert(tasks).values({
      id: taskId,
      title,
      lifecycleStatus: "open",
      scheduleKind: "exact",
      localDate: date,
      startAt,
      endAt,
      timeZone: "Asia/Shanghai",
      version: 1,
      scheduleRevision: 1,
    });
  } finally {
    await connection.client.end();
  }

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "专注", exact: true }).click();
    await expect(page.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    const response = await request.post(`${apiBase}/api/v1/focus-sessions`, {
      data: { taskId, expectedTaskVersion: 1, mode: "prepare" },
    });
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ error: "invalid_focus_transition" });
  } finally {
    await deleteTasks([taskId]);
  }
});
