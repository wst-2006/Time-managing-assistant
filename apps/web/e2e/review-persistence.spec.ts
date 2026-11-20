import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectE2EDatabase } from "./support/database";
import { focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

test("复盘页展示当天任务结果、专注时长与评价，并在刷新后保持", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const localDate = `2099-12-${String(10 + (Date.now() % 10)).padStart(2, "0")}`;
  const ids = {
    review: randomUUID(),
    task: randomUUID(),
    focus: randomUUID(),
    outcome: randomUUID(),
    feedback: randomUUID(),
  };
  const { client, db } = await connectE2EDatabase();

  try {
    await db.transaction(async (transaction) => {
      await transaction.insert(reviewSessions).values({
        id: ids.review,
        localDate,
        state: "review_open",
      });
      await transaction.insert(tasks).values({
        id: ids.task,
        title: `E2E 复盘任务 ${suffix}`,
        lifecycleStatus: "closed",
        currentOutcome: "complete",
        scheduleKind: "exact",
        localDate,
        timeZone: "Asia/Shanghai",
        startAt: new Date(`${localDate}T01:00:00.000Z`),
        endAt: new Date(`${localDate}T02:30:00.000Z`),
      });
      await transaction.insert(focusSessions).values({
        id: ids.focus,
        taskId: ids.task,
        state: "evaluated",
        rawActiveSeconds: 5_400,
        effectiveFocusSeconds: 4_800,
      });
      await transaction.insert(taskOutcomes).values({
        id: ids.outcome,
        taskId: ids.task,
        focusSessionId: ids.focus,
        outcome: "complete",
        progressPercent: 100,
        source: "app",
      });
      await transaction.insert(taskFeedback).values({
        id: ids.feedback,
        taskId: ids.task,
        focusSessionId: ids.focus,
        satisfaction: "satisfied",
        note: `E2E feedback ${suffix}`,
      });
    });

    await page.clock.setFixedTime(new Date(`${localDate}T21:00:00+08:00`));
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.locator('.workspace-layer.current[data-layer-view="review"]')).toHaveCount(1, { timeout: 1800 });
    await expect(page.getByRole("heading", { name: "把今天还给自己。", exact: true })).toBeVisible();
    await expect(page.locator(".review-colophon")).toContainText("80m");

    const summary = page.locator(".review-task-summary");
    await expect(summary.getByText(`E2E 复盘任务 ${suffix}`, { exact: true })).toBeVisible();
    await expect(summary).toContainText("完成");
    await expect(summary).toContainText("满意");

    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.locator(".review-colophon")).toContainText("80m");
    await expect(summary.getByText(`E2E 复盘任务 ${suffix}`, { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "复盘", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(summary.getByText(`E2E 复盘任务 ${suffix}`, { exact: true })).toBeVisible();
  } finally {
    await db.delete(taskFeedback).where(eq(taskFeedback.id, ids.feedback));
    await db.delete(taskOutcomes).where(eq(taskOutcomes.id, ids.outcome));
    await db.delete(focusSessions).where(eq(focusSessions.id, ids.focus));
    await db.delete(tasks).where(eq(tasks.id, ids.task));
    await db.delete(reviewMessages).where(eq(reviewMessages.reviewSessionId, ids.review));
    await db.delete(reviewSessions).where(eq(reviewSessions.id, ids.review));
    await client.end();
  }
});
