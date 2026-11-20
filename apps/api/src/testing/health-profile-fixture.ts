import type { AppDatabase } from "@personal-ai/db/client";
import { healthProfiles } from "@personal-ai/db/schema";
import { primaryHealthProfileId } from "../health-service.js";

export const testHealthProfile = {
  sex: "male",
  age: 20,
  heightCm: 175,
  weightKg: 65,
  activityLevel: "high",
  goal: "gain_muscle",
  targetWeightKg: 67,
  exercise: "力量训练每周 4 次，周末骑车",
  eatingContext: "canteen",
  likedFoods: ["番茄炒鸡蛋"],
  avoidFoods: ["海鲜"],
  bodyNotes: "左膝不适",
  city: null
};

/** Health candidates require a saved profile; tests seed one into their in-memory database. */
export async function seedHealthProfile(db: AppDatabase) {
  await db.insert(healthProfiles).values({ id: primaryHealthProfileId, profile: testHealthProfile }).onConflictDoNothing();
}
