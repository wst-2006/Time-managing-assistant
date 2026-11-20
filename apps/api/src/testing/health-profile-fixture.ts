import type { AppDatabase } from "@personal-ai/db/client";
import { healthProfiles } from "@personal-ai/db/schema";
import { primaryHealthProfileId } from "../health-service.js";

export const testHealthProfile = {
  city: null,
  basics: { sex: "male", age: 20, heightCm: 175, weightKg: 65, bodyFatPercent: 16, waistCm: 71.5 },
  goals: ["增肌"],
  stageWeightGoal: { minimumKg: 66, maximumKg: 67 },
  considerations: ["左膝不适"],
  activity: { sessionsPerWeek: 5, usualDurationMinutes: { minimum: 60, maximum: 120 }, preferredActivities: ["力量训练", "骑行"], avoidHighRisk: true },
  food: { mealContext: "食堂或外卖", mealTimes: { breakfast: "07:30", lunch: "12:00", dinner: "18:30" }, dislikes: ["海鲜"], commonFoods: ["番茄炒鸡蛋"] },
  supplements: { current: ["维生素 D"], considering: ["肌酸"], avoids: ["蛋白粉"] },
  notes: "Test profile."
};

/** Health candidates require a saved profile; tests seed one into their in-memory database. */
export async function seedHealthProfile(db: AppDatabase) {
  await db.insert(healthProfiles).values({ id: primaryHealthProfileId, profile: testHealthProfile }).onConflictDoNothing();
}
