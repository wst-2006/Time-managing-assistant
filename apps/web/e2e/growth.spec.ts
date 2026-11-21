import { expect, test } from "@playwright/test";

const days = Array.from({ length: 7 }, (_, index) => {
  const localDate = `2099-03-${String(9 + index).padStart(2, "0")}`;
  const focusMinutes = [95, 150, 0, 210, 60, 180, 120][index]!;
  const plannedTasks = [4, 5, 3, 5, 4, 4, 3][index]!;
  const completedTasks = [4, 3, 0, 5, 2, 4, 3][index]!;
  return { localDate, focusMinutes, closedTasks: completedTasks, completedTasks, plannedTasks, tone: "steady", points: 50, pointsBreakdown: { execution: 20, focus: 15, satisfaction: 10, review: 5 } };
});
const summary = {
  range: { start: "2099-03-09", end: "2099-03-15" },
  selectedDate: "2099-03-15",
  days,
  focusTrend: { granularity: "day", points: days.map((day) => ({ startDate: day.localDate, endDate: day.localDate, focusMinutes: day.focusMinutes })) },
  focusMinutes: 815, plannedTasks: 28, closedTasks: 21, completedTasks: 21, periodGrowthPercent: 72,
  satisfaction: { satisfied: 9, neutral: 4, dissatisfied: 2 },
  radar: [], currentRadar: [], currentRadarSaved: false,
  garden: { points: 60, pointsBreakdown: { execution: 30, focus: 18, satisfaction: 12, review: 6 }, scoredDays: 6, growthPercent: 72, growthCap: 100, baseGrowthScore: 60, executionPercent: 75, satisfactionPercent: 70, bambooCount: 6, treeKind: "竹", quality: 70 }
};

test("成长页：本周专注圆环、柱状图、每天完成情况圆点与连续天数，390px 不溢出", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2099-03-15T20:00:00+08:00"));
  await page.route("**/api/v1/growth/summary**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ summary }) }));
  await page.goto("/");
  await page.locator(".app-rail").getByRole("button", { name: "成长", exact: true }).click();
  await expect(page.locator('.workspace-layer.current[data-layer-view="growth"]')).toHaveCount(1, { timeout: 3000 });

  const ring = page.locator(".growth-ring");
  await expect(ring).toHaveAttribute("aria-label", /本周有效专注 815 分钟，成长评分 72\/100/);
  await expect(ring).toContainText("13.6H");
  await expect(page.locator(".growth-bamboo")).toHaveCount(0);

  await expect(page.locator(".focus-bar")).toHaveCount(7);
  await expect(page.locator(".focus-bar-value").first()).toHaveText("1.6H");

  const marks = page.locator(".day-dot-cell");
  await expect(marks).toHaveCount(7);
  // 4/4 and focus → full; 3/5 → half; no focus → empty
  await expect(marks.nth(0)).toHaveClass(/full/);
  await expect(marks.nth(1)).toHaveClass(/half/);
  await expect(marks.nth(2)).toHaveClass(/empty/);
  await expect(page.locator(".day-dots-streak strong")).toHaveText("4");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
