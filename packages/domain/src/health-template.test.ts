import { describe, expect, it } from "vitest";
import { buildHealthFixPrompt, buildHealthPromptTemplate, parseHealthAnswer } from "./health-template.js";
import { localDatesForHealthWeek } from "./health.js";

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
});
