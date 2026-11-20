import { expect, test } from "@playwright/test";

const weekStart = "2099-01-18";
const profile = {
  id: "3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1", version: 1,
  profile: {
    sex: "male", age: 20, heightCm: 175, weightKg: 65, activityLevel: "high", goal: "gain_muscle", targetWeightKg: 67,
    exercise: "力量训练每周 4 次", eatingContext: "canteen", likedFoods: ["番茄炒鸡蛋"], avoidFoods: ["海鲜"], bodyNotes: "左膝不适", city: null
  }
};

const activePlan = {
  id: "00000000-0000-4000-8000-000000000020", weekStart, state: "active", source: "template", city: null, solarTerm: "大寒", overview: "本周参考。",
  supplements: ["查看标签。"], version: 1, basedOnPlanId: null, basedOnPlanVersion: null, sourceSleepAnalysisId: null, revisionReason: null,
  days: Array.from({ length: 7 }, (_, dayIndex) => ({
    id: `00000000-0000-4000-8000-0000000002${dayIndex}`, localDate: `2099-01-${String(18 + dayIndex).padStart(2, "0")}`, dayIndex,
    content: {
      nutritionDirection: "维持正常餐盘结构。", proteinRangeGrams: { minimum: 90, maximum: 120 }, plateGuidance: ["每餐有蛋白质来源。"], seasonalVegetables: ["番茄"],
      movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按实际舒适度决定。" }
    }
  }))
};

test("健康资料：六项必填加若干选填，保存后摘要立即更新", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2099-01-18T10:00:00+08:00"));
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/v1/health/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/profile")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ profile }) });
    if (request.method() === "GET" && url.pathname.endsWith(`/weeks/${weekStart}`)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ active: activePlan, candidate: null }) });
    if (request.method() === "GET" && url.pathname.includes("/sleep-analyses/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ analyses: [] }) });
    if (request.method() === "PUT" && url.pathname.endsWith("/profile")) {
      saved = request.postDataJSON() as Record<string, unknown>;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ profile: { ...profile, version: 2, profile: (saved as { profile: unknown }).profile } }) });
    }
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unexpected_health_request" }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "健康", exact: true }).click();
  await expect(page.locator('.workspace-layer.current[data-layer-view="health"]')).toHaveCount(1, { timeout: 3000 });
  await page.getByRole("button", { name: "查看或修改资料", exact: true }).click();
  await expect(page.getByText("必填 · 六项就够", { exact: true })).toBeVisible();
  await page.getByLabel("年龄").fill("21");
  await page.getByLabel("身高（cm）").fill("176");
  await page.getByLabel("体重（kg）", { exact: true }).fill("66");
  await page.getByText("中等（每周运动 3–4 次）", { exact: true }).click();
  await page.getByText("减脂", { exact: true }).click();
  await page.getByLabel("吃饭主要靠").selectOption("takeout");
  await page.getByLabel("爱吃 / 常吃的（逗号分隔）").fill("牛肉面，酸奶");
  await page.getByLabel("所在城市").fill("示例城市");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();

  await expect.poll(() => saved).not.toBeNull();
  expect(saved).toMatchObject({
    expectedVersion: 1,
    profile: {
      sex: "male", age: 21, heightCm: 176, weightKg: 66, activityLevel: "moderate", goal: "lose_fat", targetWeightKg: 67,
      exercise: "力量训练每周 4 次", eatingContext: "takeout", likedFoods: ["牛肉面", "酸奶"], avoidFoods: ["海鲜"], bodyNotes: "左膝不适", city: "示例城市"
    }
  });
  await expect(page.getByText("176 cm · 66 kg · 减脂", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
