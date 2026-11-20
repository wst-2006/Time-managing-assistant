import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { healthDailyActuals, healthDailyReferences, healthProfiles, healthWeekPlans } from "@personal-ai/db/schema";
import {
  healthPlanContentSchema,
  localDatesForHealthWeek,
  type HealthDailyActualInput,
  type HealthPlanContent,
  type HealthProfile
} from "@personal-ai/domain/health";

export const primaryHealthProfileId = "3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1";

export type HealthPlanWithDays = {
  plan: typeof healthWeekPlans.$inferSelect;
  days: Array<typeof healthDailyReferences.$inferSelect>;
};

export class HealthProfileNotFoundError extends Error {}
export class HealthProfileVersionConflictError extends Error {
  constructor(readonly current: typeof healthProfiles.$inferSelect) { super("Health profile version conflict."); }
}
export class HealthPlanNotFoundError extends Error {}
export class HealthPlanVersionConflictError extends Error {
  constructor(readonly current: HealthPlanWithDays) { super("Health plan version conflict."); }
}
export class HealthPlanStateError extends Error {
  constructor(readonly state: string, readonly operation: string) { super(`Cannot ${operation} a health plan in ${state} state.`); }
}
export class HealthPlanBaseChangedError extends Error {
  constructor(readonly current: HealthPlanWithDays | null) { super("The health plan used as the candidate base has changed."); }
}
export class HealthActivePlanRequiredError extends Error {}

export class HealthService {
  constructor(private readonly db: AppDatabase) {}

  async getProfile() {
    const [profile] = await this.db.select().from(healthProfiles).where(eq(healthProfiles.id, primaryHealthProfileId)).limit(1);
    return profile ?? null;
  }

  async saveProfile(profile: HealthProfile, expectedVersion?: number | null) {
    return this.db.transaction(async (transaction) => {
      const [current] = await transaction.select().from(healthProfiles).where(eq(healthProfiles.id, primaryHealthProfileId)).limit(1);
      const now = new Date();
      if (!current) {
        if (expectedVersion !== undefined && expectedVersion !== null) throw new HealthProfileNotFoundError();
        const [created] = await transaction.insert(healthProfiles).values({ id: primaryHealthProfileId, profile, version: 1, createdAt: now, updatedAt: now }).returning();
        return created!;
      }
      if (expectedVersion === undefined || expectedVersion === null || current.version !== expectedVersion) {
        throw new HealthProfileVersionConflictError(current);
      }
      const [updated] = await transaction.update(healthProfiles).set({ profile, version: current.version + 1, updatedAt: now })
        .where(and(eq(healthProfiles.id, primaryHealthProfileId), eq(healthProfiles.version, expectedVersion))).returning();
      if (!updated) throw new HealthProfileVersionConflictError((await this.requireProfile(transaction)));
      return updated;
    });
  }

  async getWeek(weekStart: string): Promise<{ active: HealthPlanWithDays | null; candidate: HealthPlanWithDays | null }> {
    const [active, candidate] = await Promise.all([
      this.findPlan(weekStart, "active"),
      this.findPlan(weekStart, "candidate")
    ]);
    return { active, candidate };
  }

  async getDay(localDate: string): Promise<{ plan: typeof healthWeekPlans.$inferSelect; day: typeof healthDailyReferences.$inferSelect } | null> {
    const active = await this.findPlan(weekStartForDate(localDate), "active");
    if (!active) return null;
    const day = active.days.find((reference) => reference.localDate === localDate);
    return day ? { plan: active.plan, day } : null;
  }

  async getDailyActual(localDate: string) {
    const [actual] = await this.db.select().from(healthDailyActuals)
      .where(eq(healthDailyActuals.localDate, localDate))
      .limit(1);
    return actual ?? null;
  }

  async saveDailyActual(localDate: string, input: HealthDailyActualInput) {
    if (input.proteinGrams === null && input.fiberGrams === null && input.waterMilliliters === null) {
      await this.db.delete(healthDailyActuals).where(eq(healthDailyActuals.localDate, localDate));
      return null;
    }
    const now = new Date();
    const [actual] = await this.db.insert(healthDailyActuals).values({
      localDate,
      ...input,
      createdAt: now,
      updatedAt: now
    }).onConflictDoUpdate({
      target: healthDailyActuals.localDate,
      set: { ...input, updatedAt: now }
    }).returning();
    if (!actual) throw new Error("PostgreSQL did not return the saved health daily actual.");
    return actual;
  }

  async createManualCandidate(input: { weekStart: string; specialContext?: string | null; content: HealthPlanContent }): Promise<HealthPlanWithDays> {
    const [profileRecord, basePlan] = await Promise.all([
      this.requireProfile(this.db),
      this.findPlan(input.weekStart, "active")
    ]);
    const profile = profileRecord.profile as HealthProfile;
    return this.storeCandidate({
      weekStart: input.weekStart,
      profileVersion: profileRecord.version,
      city: profile.city,
      solarTerm: solarTermFor(input.weekStart),
      specialContext: input.specialContext ?? null,
      source: "manual",
      content: healthPlanContentSchema.parse(input.content),
      basedOnPlanId: basePlan?.plan.id,
      basedOnPlanVersion: basePlan?.plan.version,
      revisionReason: basePlan ? "由你手动编辑生成本周修订候选。确认前，原本周参考保持不变。" : "由你手动编辑生成本周参考候选；确认后才会生效。"
    });
  }

  async updateManualCandidate(id: string, input: { expectedVersion: number; content: HealthPlanContent }): Promise<HealthPlanWithDays> {
    const content = healthPlanContentSchema.parse(input.content);
    return this.runSerializable(async (transaction) => {
      const current = await this.requirePlan(transaction, id);
      if (current.plan.version !== input.expectedVersion) throw new HealthPlanVersionConflictError(current);
      if (current.plan.state !== "candidate") throw new HealthPlanStateError(current.plan.state, "edit");
      const now = new Date();
      const [updated] = await transaction.update(healthWeekPlans).set({
        source: "manual",
        overview: content.overview,
        supplements: content.supplements,
        revisionReason: "由你手动编辑当前本周候选。确认前，生效版本保持不变。",
        version: current.plan.version + 1,
        updatedAt: now
      }).where(and(eq(healthWeekPlans.id, id), eq(healthWeekPlans.version, input.expectedVersion), eq(healthWeekPlans.state, "candidate"))).returning();
      if (!updated) throw new HealthPlanVersionConflictError(await this.requirePlan(transaction, id));
      await transaction.delete(healthDailyReferences).where(eq(healthDailyReferences.healthWeekPlanId, id));
      await transaction.insert(healthDailyReferences).values(content.days.map((day, dayIndex) => ({
        id: randomUUID(), healthWeekPlanId: id, localDate: localDatesForHealthWeek(updated.weekStart)[dayIndex]!, dayIndex, content: day, createdAt: now
      })));
      return { plan: updated, days: await this.daysForPlan(transaction, id) };
    });
  }

  async confirm(id: string, expectedVersion: number): Promise<HealthPlanWithDays> {
    return this.runSerializable(async (transaction) => {
      const current = await this.requirePlan(transaction, id);
      if (current.plan.version !== expectedVersion) throw new HealthPlanVersionConflictError(current);
      if (current.plan.state === "active") return current;
      if (current.plan.state !== "candidate") throw new HealthPlanStateError(current.plan.state, "confirm");
      const now = new Date();
      const profile = await this.requireProfile(transaction);
      if (profile.version !== current.plan.profileVersion) throw new HealthProfileVersionConflictError(profile);
      const [active] = await transaction.select().from(healthWeekPlans)
        .where(and(eq(healthWeekPlans.weekStart, current.plan.weekStart), eq(healthWeekPlans.state, "active")))
        .limit(1);
      if (current.plan.basedOnPlanId) {
        if (!active || active.id !== current.plan.basedOnPlanId || active.version !== current.plan.basedOnPlanVersion) {
          throw new HealthPlanBaseChangedError(active ? { plan: active, days: await this.daysForPlan(transaction, active.id) } : null);
        }
      } else if (active) {
        throw new HealthPlanBaseChangedError({ plan: active, days: await this.daysForPlan(transaction, active.id) });
      }
      await transaction.update(healthWeekPlans).set({ state: "superseded", supersededAt: now, version: sql`${healthWeekPlans.version} + 1`, updatedAt: now })
        .where(and(eq(healthWeekPlans.weekStart, current.plan.weekStart), eq(healthWeekPlans.state, "active")));
      await transaction.update(healthWeekPlans).set({ state: "cancelled", cancelledAt: now, version: sql`${healthWeekPlans.version} + 1`, updatedAt: now })
        .where(and(eq(healthWeekPlans.weekStart, current.plan.weekStart), eq(healthWeekPlans.state, "candidate"), ne(healthWeekPlans.id, current.plan.id)));
      const [confirmed] = await transaction.update(healthWeekPlans).set({ state: "active", confirmedAt: now, version: current.plan.version + 1, updatedAt: now })
        .where(and(eq(healthWeekPlans.id, id), eq(healthWeekPlans.version, expectedVersion), eq(healthWeekPlans.state, "candidate"))).returning();
      if (!confirmed) throw new HealthPlanVersionConflictError(await this.requirePlan(transaction, id));
      return { plan: confirmed, days: current.days };
    });
  }

  async cancel(id: string, expectedVersion: number): Promise<HealthPlanWithDays> {
    return this.runSerializable(async (transaction) => {
      const current = await this.requirePlan(transaction, id);
      if (current.plan.version !== expectedVersion) throw new HealthPlanVersionConflictError(current);
      if (current.plan.state !== "candidate") throw new HealthPlanStateError(current.plan.state, "cancel");
      const now = new Date();
      const [cancelled] = await transaction.update(healthWeekPlans).set({ state: "cancelled", cancelledAt: now, version: current.plan.version + 1, updatedAt: now })
        .where(and(eq(healthWeekPlans.id, id), eq(healthWeekPlans.version, expectedVersion), eq(healthWeekPlans.state, "candidate"))).returning();
      if (!cancelled) throw new HealthPlanVersionConflictError(await this.requirePlan(transaction, id));
      return { plan: cancelled, days: current.days };
    });
  }

  private async storeCandidate(input: {
    weekStart: string;
    profileVersion: number;
    city: string | null;
    solarTerm: string;
    specialContext: string | null;
    source: "template" | "ai" | "manual";
    content: HealthPlanContent;
    basedOnPlanId?: string;
    basedOnPlanVersion?: number;
    revisionReason?: string;
  }): Promise<HealthPlanWithDays> {
    const parsed = healthPlanContentSchema.parse(input.content);
    return this.runSerializable(async (transaction) => {
      const profile = await this.requireProfile(transaction);
      if (profile.version !== input.profileVersion) throw new HealthProfileVersionConflictError(profile);
      const now = new Date();
      await transaction.update(healthWeekPlans).set({
        state: "cancelled", cancelledAt: now, version: sql`${healthWeekPlans.version} + 1`, updatedAt: now
      }).where(and(eq(healthWeekPlans.weekStart, input.weekStart), eq(healthWeekPlans.state, "candidate")));
      const [plan] = await transaction.insert(healthWeekPlans).values({
        id: randomUUID(), weekStart: input.weekStart, state: "candidate", source: input.source, profileVersion: input.profileVersion,
        city: input.city, solarTerm: input.solarTerm, specialContext: input.specialContext,
        basedOnPlanId: input.basedOnPlanId ?? null, basedOnPlanVersion: input.basedOnPlanVersion ?? null,
        revisionReason: input.revisionReason ?? null,
        overview: parsed.overview, supplements: parsed.supplements,
        version: 1, createdAt: now, updatedAt: now
      }).returning();
      if (!plan) throw new Error("PostgreSQL did not return the health candidate.");
      const days = parsed.days.map((content, dayIndex) => ({
        id: randomUUID(), healthWeekPlanId: plan.id, localDate: localDatesForHealthWeek(input.weekStart)[dayIndex]!, dayIndex, content, createdAt: now
      }));
      await transaction.insert(healthDailyReferences).values(days);
      return { plan, days: await this.daysForPlan(transaction, plan.id) };
    });
  }

  private async findPlan(weekStart: string, state: "active" | "candidate"): Promise<HealthPlanWithDays | null> {
    const [plan] = await this.db.select().from(healthWeekPlans)
      .where(and(eq(healthWeekPlans.weekStart, weekStart), eq(healthWeekPlans.state, state)))
      .orderBy(desc(healthWeekPlans.createdAt)).limit(1);
    return plan ? { plan, days: await this.daysForPlan(this.db, plan.id) } : null;
  }

  private async requireProfile(db: AppDatabase) {
    const [profile] = await db.select().from(healthProfiles).where(eq(healthProfiles.id, primaryHealthProfileId)).limit(1);
    if (!profile) throw new HealthProfileNotFoundError();
    return profile;
  }

  private async requirePlan(db: AppDatabase, id: string): Promise<HealthPlanWithDays> {
    const [plan] = await db.select().from(healthWeekPlans).where(eq(healthWeekPlans.id, id)).limit(1);
    if (!plan) throw new HealthPlanNotFoundError();
    return { plan, days: await this.daysForPlan(db, id) };
  }

  private daysForPlan(db: AppDatabase, planId: string) {
    return db.select().from(healthDailyReferences).where(eq(healthDailyReferences.healthWeekPlanId, planId)).orderBy(asc(healthDailyReferences.dayIndex));
  }

  private async runSerializable<T>(operation: (transaction: AppDatabase) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.db.transaction(async (transaction) => operation(transaction as unknown as AppDatabase), { isolationLevel: "serializable" });
      } catch (error) {
        if (!isSerializationFailure(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 20));
      }
    }
    throw new Error("Health transaction retry budget exhausted.");
  }
}

function solarTermFor(localDate: string): string {
  const monthDay = localDate.slice(5);
  const terms: Array<[string, string]> = [["01-05", "小寒"], ["01-20", "大寒"], ["02-04", "立春"], ["02-19", "雨水"], ["03-06", "惊蛰"], ["03-21", "春分"], ["04-05", "清明"], ["04-20", "谷雨"], ["05-06", "立夏"], ["05-21", "小满"], ["06-06", "芒种"], ["06-21", "夏至"], ["07-07", "小暑"], ["07-23", "大暑"], ["08-08", "立秋"], ["08-23", "处暑"], ["09-08", "白露"], ["09-23", "秋分"], ["10-08", "寒露"], ["10-23", "霜降"], ["11-07", "立冬"], ["11-22", "小雪"], ["12-07", "大雪"], ["12-22", "冬至"]];
  let current = "冬至";
  for (const [boundary, term] of terms) if (monthDay >= boundary) current = term;
  return current;
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}

function weekStartForDate(localDate: string): string {
  const current = new Date(`${localDate}T00:00:00.000Z`);
  current.setUTCDate(current.getUTCDate() - current.getUTCDay());
  return current.toISOString().slice(0, 10);
}
