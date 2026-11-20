import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedHealthProfile } from "./testing/health-profile-fixture.js";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { healthDailyReferences, healthWeekPlans } from "@personal-ai/db/schema";
import type { HealthPlanContent } from "@personal-ai/domain/health";
import { eq, inArray } from "drizzle-orm";
import { HealthPlanBaseChangedError, HealthService } from "./health-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
beforeAll(async () => { await seedHealthProfile(connection.db); });
const service = new HealthService(connection.db);

function healthContent(overview: string): HealthPlanContent {
  return {
    overview,
    supplements: ["测试中只保留用户确认边界。"],
    days: Array.from({ length: 7 }, () => ({
      nutritionDirection: "维持正常餐盘结构。",
      proteinRangeGrams: { minimum: 90, maximum: 120 },
      plateGuidance: ["每餐有主要蛋白质来源。"],
      seasonalVegetables: ["番茄"],
      seasonalGuidance: null,
      seasonalPoem: null,
      movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按实际舒适度决定。" }
    }))
  };
}

function createManual(weekStart: string, overview: string, specialContext: string | null = null) {
  return service.createManualCandidate({ weekStart, specialContext, content: healthContent(overview) });
}

afterAll(async () => { await connection.client.end(); });

describe("health reference persistence", () => {





  it("stores a user-edited weekly reference as a manual candidate before it replaces the active week", async () => {
    const weekStart = "2099-03-15";
    const base = await createManual(weekStart, "手动编辑前的用户确认参考");
    const active = await service.confirm(base.plan.id, base.plan.version);
    let manualId: string | null = null;
    try {
      const manual = await service.createManualCandidate({
        weekStart,
        content: {
          overview: "这是用户主动编辑的本周参考。",
          supplements: ["用户选择保留为查看参考。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      });
      manualId = manual.plan.id;
      expect(manual.plan).toMatchObject({ state: "candidate", source: "manual", basedOnPlanId: active.plan.id, basedOnPlanVersion: active.plan.version });
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(active.plan.id);
      const updated = await service.updateManualCandidate(manual.plan.id, {
        expectedVersion: manual.plan.version,
        content: {
          overview: "这是经过用户再次手动编辑的本周参考。",
          supplements: ["用户确认保留为查看参考。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      });
      expect(updated.plan).toMatchObject({ id: manual.plan.id, state: "candidate", source: "manual", version: manual.plan.version + 1, overview: "这是经过用户再次手动编辑的本周参考。" });
      const confirmed = await service.confirm(updated.plan.id, updated.plan.version);
      expect(confirmed.plan).toMatchObject({ id: updated.plan.id, state: "active", source: "manual" });
    } finally {
      const planIds = [base.plan.id, ...(manualId ? [manualId] : [])];
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, planIds));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, planIds));
      });
    }
  });

  it("binds manual revisions to the active version and rejects a stale confirmation", async () => {
    const weekStart = "2099-04-12";
    const base = await createManual(weekStart, "当前生效参考");
    const active = await service.confirm(base.plan.id, base.plan.version);
    const revision = await createManual(weekStart, "周三外出，用餐场景会变化", "周三外出，用餐场景会变化");
    try {
      expect(revision.plan).toMatchObject({
        state: "candidate",
        basedOnPlanId: active.plan.id,
        basedOnPlanVersion: active.plan.version
      });
      expect(revision.plan.revisionReason).toContain("修订候选");
      expect(revision.plan.overview).toBe("周三外出，用餐场景会变化");
      await connection.db.update(healthWeekPlans).set({ version: active.plan.version + 1 }).where(eq(healthWeekPlans.id, active.plan.id));
      await expect(service.confirm(revision.plan.id, revision.plan.version)).rejects.toBeInstanceOf(HealthPlanBaseChangedError);
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(active.plan.id);
    } finally {
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, [base.plan.id, revision.plan.id]));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, [base.plan.id, revision.plan.id]));
      });
    }
  });
});
