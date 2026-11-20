import { z } from "zod";
import { reviewDateSchema } from "./review.js";

const textList = z.array(z.string().trim().min(1).max(160)).max(24);

export const healthActivityLevelSchema = z.enum(["sedentary", "light", "moderate", "high"]);
export const healthGoalSchema = z.enum(["lose_fat", "gain_muscle", "maintain", "energy"]);
export const healthEatingContextSchema = z.enum(["canteen", "takeout", "cook", "mixed"]);

export const healthActivityLevelLabels: Record<z.infer<typeof healthActivityLevelSchema>, string> = {
  sedentary: "久坐为主（几乎不运动）",
  light: "轻度（每周运动 1–2 次或日常走动较多）",
  moderate: "中等（每周运动 3–4 次）",
  high: "高强度（每周运动 5 次以上或体力劳动）"
};
export const healthGoalLabels: Record<z.infer<typeof healthGoalSchema>, string> = {
  lose_fat: "减脂", gain_muscle: "增肌", maintain: "保持体重", energy: "改善精力与作息"
};
export const healthEatingContextLabels: Record<z.infer<typeof healthEatingContextSchema>, string> = {
  canteen: "食堂为主", takeout: "外卖为主", cook: "自己做饭为主", mixed: "几种都有"
};

/**
 * Health profile: six required basics, plus a few optional details that keep weekly
 * references from all looking the same.
 */
const healthProfileObjectSchema = z.object({
  sex: z.enum(["male", "female", "other"]),
  age: z.number().int().min(12).max(120),
  heightCm: z.number().min(120).max(230),
  weightKg: z.number().min(30).max(300),
  activityLevel: healthActivityLevelSchema,
  goal: healthGoalSchema,
  targetWeightKg: z.number().min(30).max(300).nullable(),
  exercise: z.string().trim().max(300).nullable(),
  eatingContext: healthEatingContextSchema.nullable(),
  likedFoods: textList,
  avoidFoods: textList,
  bodyNotes: z.string().trim().max(500).nullable(),
  city: z.string().trim().min(1).max(120).nullable()
}).strict();

/** Profiles saved by earlier builds used a longer nested form; convert them on the way in. */
export function upgradeLegacyHealthProfile(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("basics" in value)) return value;
  const legacy = value as {
    city?: string | null;
    basics?: { sex?: string; age?: number; heightCm?: number; weightKg?: number };
    goals?: string[];
    stageWeightGoal?: { minimumKg?: number; maximumKg?: number };
    considerations?: string[];
    activity?: { sessionsPerWeek?: number; preferredActivities?: string[]; usualDurationMinutes?: { minimum?: number; maximum?: number } };
    food?: { mealContext?: string; dislikes?: string[]; commonFoods?: string[] };
    notes?: string | null;
  };
  const sessions = legacy.activity?.sessionsPerWeek ?? 0;
  const goalText = (legacy.goals ?? []).join(" ");
  const target = legacy.stageWeightGoal;
  const duration = legacy.activity?.usualDurationMinutes;
  const exerciseParts = [
    legacy.activity?.preferredActivities?.length ? legacy.activity.preferredActivities.join("、") : "",
    sessions ? `每周约 ${sessions} 次` : "",
    duration?.minimum && duration?.maximum ? `每次 ${duration.minimum}–${duration.maximum} 分钟` : ""
  ].filter(Boolean);
  const bodyNotes = [...(legacy.considerations ?? []), legacy.notes ?? ""].map((item) => item.trim()).filter(Boolean).join("；");
  return {
    sex: legacy.basics?.sex,
    age: legacy.basics?.age,
    heightCm: legacy.basics?.heightCm,
    weightKg: legacy.basics?.weightKg,
    activityLevel: sessions >= 5 ? "high" : sessions >= 3 ? "moderate" : sessions >= 1 ? "light" : "sedentary",
    goal: /增肌|增重/.test(goalText) ? "gain_muscle" : /减脂|减重|瘦/.test(goalText) ? "lose_fat" : /精力|睡眠|作息/.test(goalText) ? "energy" : "maintain",
    targetWeightKg: target?.minimumKg && target?.maximumKg ? Math.round(((target.minimumKg + target.maximumKg) / 2) * 10) / 10 : null,
    exercise: exerciseParts.length ? exerciseParts.join("，").slice(0, 300) : null,
    eatingContext: null,
    likedFoods: (legacy.food?.commonFoods ?? []).slice(0, 24),
    avoidFoods: (legacy.food?.dislikes ?? []).slice(0, 24),
    bodyNotes: bodyNotes ? bodyNotes.slice(0, 500) : null,
    city: legacy.city ?? null
  };
}

export const healthProfileSchema = z.preprocess(upgradeLegacyHealthProfile, healthProfileObjectSchema);

export const healthMovementCategorySchema = z.enum(["strength", "volleyball", "running", "walking", "cycling", "recovery", "rest"]);
export const healthIntensitySchema = z.enum(["rest", "low", "moderate", "high"]);
const healthGramRangeSchema = z.object({ minimum: z.number().int().min(0).max(1000), maximum: z.number().int().min(0).max(1000) }).strict();
const healthMealExamplesSchema = z.object({
  breakfast: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
  lunch: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
  dinner: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
  snack: z.array(z.string().trim().min(1).max(160)).max(5)
}).strict();
const healthFoodReferenceSchema = z.object({
  proteinOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  fiberOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  carbOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  fatOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10).optional()
}).strict();

export const healthDailyReferenceSchema = z.object({
  nutritionDirection: z.string().trim().min(1).max(700),
  proteinRangeGrams: z.object({ minimum: z.number().int().min(1).max(300), maximum: z.number().int().min(1).max(300) }).strict(),
  nutritionTargets: z.object({
    carbohydrateGrams: healthGramRangeSchema,
    fatGrams: healthGramRangeSchema,
    fiberGrams: healthGramRangeSchema,
    hydrationLiters: z.object({ minimum: z.number().min(0).max(10), maximum: z.number().min(0).max(10) }).strict(),
    macroRatioPercent: z.object({ protein: z.number().min(0).max(100), carbohydrate: z.number().min(0).max(100), fat: z.number().min(0).max(100) }).strict()
  }).strict().optional(),
  hydrationGuidance: z.array(z.string().trim().min(1).max(180)).min(1).max(6).optional(),
  mealExamples: healthMealExamplesSchema.optional(),
  proteinRotationSources: z.array(z.string().trim().min(1).max(120)).min(1).max(5).optional(),
  foodReference: healthFoodReferenceSchema.optional(),
  fruitOptions: z.array(z.string().trim().min(1).max(120)).min(1).max(10).optional(),
  plateGuidance: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
  seasonalVegetables: z.array(z.string().trim().min(1).max(80)).min(1).max(6),
  seasonalGuidance: z.string().trim().min(1).max(500).nullable().optional(),
  seasonalPoem: z.object({
    title: z.string().trim().min(1).max(120),
    author: z.string().trim().min(1).max(120),
    excerpt: z.string().trim().min(1).max(180),
    relevance: z.string().trim().min(1).max(300)
  }).strict().nullable().optional(),
  movement: z.object({
    category: healthMovementCategorySchema,
    durationMinutes: z.object({ minimum: z.number().int().min(0).max(240), maximum: z.number().int().min(0).max(300) }).strict(),
    intensity: healthIntensitySchema,
    highIntensity: z.boolean(),
    safetyReminder: z.string().trim().min(1).max(400),
    focus: z.array(z.string().trim().min(1).max(180)).min(1).max(8).optional(),
    safetyNotes: z.array(z.string().trim().min(1).max(220)).min(1).max(8).optional()
  }).strict()
}).strict().superRefine((reference, context) => {
  if (reference.proteinRangeGrams.minimum > reference.proteinRangeGrams.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["proteinRangeGrams"], message: "Protein range minimum cannot exceed maximum" });
  }
  const targets = reference.nutritionTargets;
  if (targets) {
    for (const [key, range] of Object.entries({ carbohydrateGrams: targets.carbohydrateGrams, fatGrams: targets.fatGrams, fiberGrams: targets.fiberGrams })) {
      if (range.minimum > range.maximum) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nutritionTargets", key], message: `${key} minimum cannot exceed maximum` });
    }
    if (targets.hydrationLiters.minimum > targets.hydrationLiters.maximum) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nutritionTargets", "hydrationLiters"], message: "Hydration minimum cannot exceed maximum" });
    const macroTotal = targets.macroRatioPercent.protein + targets.macroRatioPercent.carbohydrate + targets.macroRatioPercent.fat;
    if (macroTotal < 95 || macroTotal > 105) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nutritionTargets", "macroRatioPercent"], message: "Macro ratio percentages must total approximately 100" });
  }
  if (reference.movement.durationMinutes.minimum > reference.movement.durationMinutes.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["movement", "durationMinutes"], message: "Movement duration minimum cannot exceed maximum" });
  }
});

export const healthPlanContentSchema = z.object({
  overview: z.string().trim().min(1).max(2000),
  supplements: z.array(z.string().trim().min(1).max(320)).min(1).max(8),
  days: z.array(healthDailyReferenceSchema).length(7)
}).strict();

export const generatedHealthPlanContentSchema = healthPlanContentSchema.superRefine((plan, context) => {
  plan.days.forEach((day, dayIndex) => {
    for (const key of ["nutritionTargets", "hydrationGuidance", "mealExamples", "proteinRotationSources", "foodReference", "fruitOptions"] as const) {
      if (day[key] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["days", dayIndex, key], message: `${key} is required for newly generated health references` });
    }

    const proteinConversions = day.foodReference?.proteinOptions ?? [];
    for (const [label, pattern] of [
      ["鸡蛋", /(?:\d+(?:\.\d+)?\s*个[^；，。]*鸡蛋|鸡蛋[^；，。]*\d+(?:\.\d+)?\s*个)/u],
      ["牛肉", /(?:\d+(?:\.\d+)?\s*(?:克|g)[^；，。]*牛肉|牛肉[^；，。]*\d+(?:\.\d+)?\s*(?:克|g))/iu],
      ["鸡胸肉", /(?:\d+(?:\.\d+)?\s*(?:克|g)[^；，。]*鸡胸(?:肉)?|鸡胸(?:肉)?[^；，。]*\d+(?:\.\d+)?\s*(?:克|g))/iu]
    ] as const) {
      const conversion = proteinConversions.find((item) => pattern.test(item));
      if (!conversion || !/\d/u.test(conversion)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["days", dayIndex, "foodReference", "proteinOptions"],
          message: `protein conversion for ${label} is required for newly generated health references`
        });
      }
    }

    for (const [field, label, pattern] of [
      ["carbOptions", "熟米饭", /(?:\d+(?:\.\d+)?[^；，。]*碗[^；，。]*(?:熟)?米饭|(?:熟)?米饭[^；，。]*\d+(?:\.\d+)?[^；，。]*碗)/u],
      ["fiberOptions", "白菜", /(?:\d+(?:\.\d+)?\s*(?:克|g)[^；，。]*白菜|白菜[^；，。]*\d+(?:\.\d+)?\s*(?:克|g))/iu],
      ["fatOptions", "食用油", /(?:\d+(?:\.\d+)?[^；，。]*汤匙[^；，。]*(?:食用)?油|(?:食用)?油[^；，。]*\d+(?:\.\d+)?[^；，。]*汤匙)/u]
    ] as const) {
      const conversion = day.foodReference?.[field]?.find((item) => pattern.test(item));
      if (!conversion || !/\d/u.test(conversion)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["days", dayIndex, "foodReference", field],
          message: `food conversion for ${label} is required for newly generated health references`
        });
      }
    }

    if (!(day.hydrationGuidance ?? []).some((item) => /纸杯/u.test(item) && /\d/u.test(item))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["days", dayIndex, "hydrationGuidance"],
        message: "paper cup hydration conversion is required for newly generated health references"
      });
    }

    if ((day.fruitOptions?.length ?? 0) < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["days", dayIndex, "fruitOptions"],
        message: "at least two fruit options with portions are required for newly generated health references"
      });
    }
    day.fruitOptions?.forEach((item, itemIndex) => {
      // Match an adjacent quantity and unit, including common fruit counters.
      // NFKC accepts full-width digits/units without changing the saved wording.
      const portion = /(?:\d+(?:\.\d+)?|[零一二两三四五六七八九十百半]+)\s*(?:小|中|大)?\s*(?:千克|公斤|kg|克|g|个|根|只|枚|颗|粒|瓣|串|份|片|杯|碗|块|把|两|斤)/iu;
      if (!portion.test(item.normalize("NFKC"))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["days", dayIndex, "fruitOptions", itemIndex],
          message: `fruit portion missing: ${item.slice(0, 80)}`
        });
      }
    });
  });
});

export const healthWeekStartSchema = reviewDateSchema.refine((value) => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 0, "weekStart must be a Sunday");
export const createHealthPlanCandidateSchema = z.object({
  weekStart: healthWeekStartSchema,
  specialContext: z.string().trim().max(1000).nullable().optional()
}).strict();
export const createManualHealthPlanCandidateSchema = z.object({
  weekStart: healthWeekStartSchema,
  specialContext: z.string().trim().max(1000).nullable().optional(),
  content: healthPlanContentSchema
}).strict();
export const updateManualHealthPlanCandidateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  content: healthPlanContentSchema
}).strict();
export const saveHealthProfileSchema = z.object({
  expectedVersion: z.number().int().positive().nullable().optional(),
  profile: healthProfileSchema
}).strict();
export const healthPlanConfirmationSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const saveHealthDailyActualSchema = z.object({
  proteinGrams: z.number().int().min(0).max(1000).nullable(),
  fiberGrams: z.number().int().min(0).max(200).nullable(),
  waterMilliliters: z.number().int().min(0).max(10_000).nullable()
}).strict();
export type HealthProfile = z.infer<typeof healthProfileSchema>;
export type HealthDailyReference = z.infer<typeof healthDailyReferenceSchema>;
export type HealthPlanContent = z.infer<typeof healthPlanContentSchema>;
export type ManualHealthPlanCandidate = z.infer<typeof createManualHealthPlanCandidateSchema>;
export type HealthDailyActualInput = z.infer<typeof saveHealthDailyActualSchema>;

export function localDatesForHealthWeek(weekStart: string): string[] {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(start);
    current.setUTCDate(current.getUTCDate() + index);
    return current.toISOString().slice(0, 10);
  });
}
