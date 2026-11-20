import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedHealthProfile } from "./testing/health-profile-fixture.js";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { healthDailyReferences, healthWeekPlans } from "@personal-ai/db/schema";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "./app.js";
import { HealthService } from "./health-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
beforeAll(async () => { await seedHealthProfile(connection.db); });
const service = new HealthService(connection.db);
const testContent = (overview: string) => ({
  overview,
  supplements: ["仅供测试查看。"],
  days: Array.from({ length: 7 }, () => ({
    nutritionDirection: "维持正常餐盘结构。",
    proteinRangeGrams: { minimum: 90, maximum: 120 },
    plateGuidance: ["每餐有主要蛋白质来源。"],
    seasonalVegetables: ["番茄"],
    seasonalGuidance: null,
    seasonalPoem: null,
    movement: { category: "recovery" as const, durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low" as const, highIntensity: false, safetyReminder: "按实际舒适度决定。" }
  }))
});
const createManual = (weekStart: string, overview: string) => service.createManualCandidate({ weekStart, content: testContent(overview) });
const app = buildApp({
  healthService: service
});

afterAll(async () => {
  await app.close();
  await connection.client.end();
});

describe("health routes", () => {


  it("returns only the confirmed daily reference for the Today summary", async () => {
    const weekStart = "2099-05-03";
    const candidate = await createManual(weekStart, "今日摘要测试参考");
    try {
      const before = await app.inject({ method: "GET", url: "/api/v1/health/days/2099-05-04" });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ reference: null });

      const active = await service.confirm(candidate.plan.id, candidate.plan.version);
      const after = await app.inject({ method: "GET", url: "/api/v1/health/days/2099-05-04" });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({ reference: { plan: { id: active.plan.id, state: "active" }, day: { localDate: "2099-05-04", dayIndex: 1 } } });
    } finally {
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(eq(healthDailyReferences.healthWeekPlanId, candidate.plan.id));
        await transaction.delete(healthWeekPlans).where(eq(healthWeekPlans.id, candidate.plan.id));
      });
    }
  });



  it("accepts a complete manual candidate and keeps the active plan unchanged before confirmation", async () => {
    const weekStart = "2099-03-22";
    const base = await createManual(weekStart, "手动候选测试参考");
    const active = await service.confirm(base.plan.id, base.plan.version);
    let manualId: string | null = null;
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/health/weeks/manual-candidates", payload: {
        weekStart,
        content: {
          overview: "这是用户手动编辑的候选。",
          supplements: ["仅供查看。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      } });
      expect(response.statusCode).toBe(201);
      const manual = response.json().plan as { id: string; source: string; state: string; version: number; basedOnPlanId: string };
      manualId = manual.id;
      expect(manual).toMatchObject({ source: "manual", state: "candidate", basedOnPlanId: active.plan.id });
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(active.plan.id);
      const updated = await app.inject({ method: "PUT", url: `/api/v1/health/weeks/${manual.id}/manual-candidate`, payload: {
        expectedVersion: manual.version,
        content: {
          overview: "这是用户再次编辑后的候选。",
          supplements: ["仅供查看。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().plan).toMatchObject({ id: manual.id, source: "manual", overview: "这是用户再次编辑后的候选。" });
      const stale = await app.inject({ method: "PUT", url: `/api/v1/health/weeks/${manual.id}/manual-candidate`, payload: {
        expectedVersion: manual.version,
        content: {
          overview: "过期页面不应覆盖最新候选。",
          supplements: ["仅供查看。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "health_plan_version_conflict", plan: { id: manual.id, overview: "这是用户再次编辑后的候选。" } });
    } finally {
      const planIds = [base.plan.id, ...(manualId ? [manualId] : [])];
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, planIds));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, planIds));
      });
    }
  });
});
