import { describe, expect, it } from "vitest";
import { buildHealthFixPrompt, buildHealthPromptTemplate, parseHealthAnswer } from "./health-template.js";
import { healthProfileSchema, localDatesForHealthWeek } from "./health.js";

const day = {
  nutritionDirection: "维持正常餐盘结构。",
  proteinRangeGrams: { minimum: 90, maximum: 120 },
  nutritionTargets: {
    carbohydrateGrams: { minimum: 200, maximum: 260 }, fatGrams: { minimum: 50, maximum: 70 }, fiberGrams: { minimum: 25, maximum: 35 },
    hydrationLiters: { minimum: 1.8, maximum: 2.4 }, macroRatioPercent: { protein: 25, carbohydrate: 50, fat: 25 }
  },
  hydrationGuidance: ["2L 水约等于 8 个纸杯"],
  mealExamples: { breakfast: ["燕麦"], lunch: ["米饭"], dinner: ["面"], snack: [] },
  proteinRotationSources: ["鸡蛋"],
  foodReference: { proteinOptions: ["约等于 6 个鸡蛋", "约等于 400 克牛肉", "约等于 350 克鸡胸肉"], fiberOptions: ["约等于 500 克白菜"], carbOptions: ["约等于 3 碗熟米饭"], fatOptions: ["约等于 3 汤匙食用油"] },
  fruitOptions: ["苹果 1 个", "香蕉 1 根"],
  plateGuidance: ["一半蔬菜"],
  seasonalVegetables: ["白菜"],
  seasonalGuidance: null,
  seasonalPoem: null
};
const answer = (days: unknown[]) => `好的，这是你的参考：\n\`\`\`json\n${JSON.stringify({ overview: "本周以稳定为主。", supplements: ["维生素 D 按标签"], days })}\n\`\`\`\n希望有帮助！`;

describe("health answer parsing", () => {
  it("finds the JSON inside chat text and accepts a complete week", () => {
    const result = parseHealthAnswer(answer(Array.from({ length: 7 }, () => day)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.relaxed).toBe(false);
      expect(result.content.days).toHaveLength(7);
      expect(result.content.days[0]!.movement.category).toBe("rest");
    }
  });

  it("maps common synonyms back to the canonical fields", () => {
    const loose = { ...day, foodReference: undefined, fruitOptions: undefined, fruit: ["苹果 1 个", "梨 1 个"], hydration: "1.5-2L，约 8 个纸杯" } as Record<string, unknown>;
    delete loose.foodReference; delete loose.fruitOptions;
    const result = parseHealthAnswer(answer(Array.from({ length: 7 }, () => loose)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.relaxed).toBe(true);
      expect(result.content.days[0]!.fruitOptions).toEqual(["苹果 1 个", "梨 1 个"]);
    }
  });

  it("explains missing days and broken JSON in Chinese", () => {
    const short = parseHealthAnswer(answer([day, day]));
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.stage).toBe("structure");
      expect(short.issues[0]!.message).toContain("七日安排");
      expect(buildHealthFixPrompt(short.issues)).toContain("重新输出完整的 JSON");
    }
    const broken = parseHealthAnswer("```json\n{\"overview\": \"截断");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.stage).toBe("json");
    expect(parseHealthAnswer("   ").ok).toBe(false);
  });

  it("builds a template that carries the profile, dates and JSON skeleton", () => {
    const template = buildHealthPromptTemplate({ profile: null, weekStart: "2026-11-15", solarTerm: "立冬", dates: localDatesForHealthWeek("2026-11-15"), extraContext: "这周出差" });
    expect(template).toContain("2026-11-21（周六）");
    expect(template).toContain("这周出差");
    expect(template).toContain("```json");
    expect(template).toContain("proteinOptions");
  });

  it("describes a filled profile in plain Chinese, including the optional details", () => {
    const profile = healthProfileSchema.parse({
      sex: "female", age: 21, heightCm: 163, weightKg: 55, activityLevel: "moderate", goal: "lose_fat",
      targetWeightKg: 52, exercise: "跑步每周 3 次", eatingContext: "canteen", likedFoods: ["番茄炒蛋"], avoidFoods: ["香菜"],
      bodyNotes: "胃不太好", city: "北京"
    });
    const template = buildHealthPromptTemplate({ profile, weekStart: "2026-11-15", solarTerm: "立冬", dates: localDatesForHealthWeek("2026-11-15") });
    for (const text of ["女", "163 cm", "BMI 约 20.7", "中等", "减脂", "52 kg", "跑步每周 3 次", "食堂为主", "番茄炒蛋", "香菜", "胃不太好", "北京"]) {
      expect(template).toContain(text);
    }
    expect(template).not.toContain("\"activityLevel\"");
  });

  it("upgrades a profile saved in the old long form", () => {
    const upgraded = healthProfileSchema.parse({
      city: null,
      basics: { sex: "male", age: 20, heightCm: 175, weightKg: 65, bodyFatPercent: 16, waistCm: 71.5 },
      goals: ["增肌"], stageWeightGoal: { minimumKg: 66, maximumKg: 67 }, considerations: ["左膝不适"],
      activity: { sessionsPerWeek: 5, usualDurationMinutes: { minimum: 60, maximum: 120 }, preferredActivities: ["力量训练"], avoidHighRisk: true },
      food: { mealContext: "食堂", mealTimes: { breakfast: "07:30", lunch: "12:00", dinner: "18:30" }, dislikes: ["海鲜"], commonFoods: ["鸡蛋"] },
      supplements: { current: [], considering: [], avoids: [] }, notes: null
    });
    expect(upgraded).toMatchObject({ sex: "male", activityLevel: "high", goal: "gain_muscle", targetWeightKg: 66.5, avoidFoods: ["海鲜"], likedFoods: ["鸡蛋"], bodyNotes: "左膝不适" });
    expect(upgraded.exercise).toContain("力量训练");
  });
});
