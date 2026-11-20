import type { ZodIssue } from "zod";
import { generatedHealthPlanContentSchema, healthActivityLevelLabels, healthEatingContextLabels, healthGoalLabels, healthPlanContentSchema, type HealthPlanContent, type HealthProfile } from "./health.js";

/*
 * 健康参考的“模板 → 网页版 AI → 粘贴回来”流程。
 *
 * 软件不再调用任何 AI。用户复制 buildHealthPromptTemplate() 生成的提问模板，
 * 发给任意网页版 AI；把 AI 的回答粘贴回来后，parseHealthAnswer() 用代码
 * 找出 JSON、把常见的同义字段改回标准字段，再按健康参考的结构逐项校验。
 */

const HEALTH_PLAN_OUTPUT_CONTRACT = [
  "输出对象只允许 overview、supplements、days 三个根字段，不得增加解释、日期索引或元数据字段。",
  "days 必须恰好 7 项并按周日到周六排序；每个日对象不得增加 day、date、weekday、label 等字段。",
  "overview 为 1-2000 字；supplements 为 1-8 条，每条 1-320 字。",
  "每个日对象的 nutritionDirection、proteinRangeGrams、nutritionTargets、hydrationGuidance、mealExamples、proteinRotationSources、foodReference、fruitOptions、plateGuidance、seasonalVegetables、seasonalGuidance、seasonalPoem 全部必须出现。",
  "所有 minimum 必须小于或等于 maximum；蛋白质 1-300g，碳水/脂肪/纤维 0-1000g，饮水 0-10L，运动时长 minimum 0-240 分钟、maximum 0-300 分钟。",
  "macroRatioPercent 的 protein、carbohydrate、fat 可为整数或小数，均在 0-100，三项合计必须在 95-105。",
  "mealExamples 的 breakfast/lunch/dinner 各 1-6 条，snack 0-5 条；proteinRotationSources 1-5 条；foodReference 的 proteinOptions、fiberOptions、carbOptions、fatOptions 各 1-10 条；fruitOptions 2-6 条。fruitOptions 每个数组元素只写一种水果和明确份量，例如 [\"苹果 1 个\",\"香蕉 1 根\"]；不能只写适量、少许，也不要把总量或通用说明单独放入这个数组。",
  "不得返回 movement、exercise、training、workout 或任何训练计划字段；运动安排由用户自己管理。",
  "不得省略字段，不得把数组写成字符串，不得把数字或布尔值写成解释性文字。"
].join("\n");

const FIELD_LABELS: Record<string, string> = {
  overview: "本周摘要",
  supplements: "补充剂提示",
  days: "七日安排",
  nutritionDirection: "饮食方向",
  proteinRangeGrams: "蛋白质范围",
  nutritionTargets: "营养目标",
  carbohydrateGrams: "碳水范围",
  fatGrams: "脂肪范围",
  fiberGrams: "膳食纤维范围",
  hydrationLiters: "饮水范围",
  macroRatioPercent: "三大营养素比例",
  protein: "蛋白质比例",
  carbohydrate: "碳水比例",
  fat: "脂肪比例",
  hydrationGuidance: "分时饮水建议",
  mealExamples: "三餐示例",
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  snack: "加餐",
  proteinRotationSources: "蛋白来源轮换",
  foodReference: "替代食材",
  fruitOptions: "水果推荐",
  proteinOptions: "蛋白替代",
  fiberOptions: "纤维替代",
  carbOptions: "碳水替代",
  fatOptions: "脂肪替代",
  plateGuidance: "餐盘提示",
  seasonalVegetables: "时令蔬菜",
  seasonalGuidance: "时令提示",
  seasonalPoem: "时令诗句",
  minimum: "下限",
  maximum: "上限"
};

const EXPECTED_TYPE_LABELS: Record<string, string> = {
  string: "文字",
  number: "数字",
  integer: "整数",
  boolean: "布尔值",
  array: "列表",
  object: "对象"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickKnown(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  }
  return result;
}

function normalizeNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : value;
}

function normalizeRange(value: unknown): unknown {
  const range = pickKnown(value, ["minimum", "maximum"]);
  if (!range) return value;
  if ("minimum" in range) range.minimum = normalizeNumber(range.minimum);
  if ("maximum" in range) range.maximum = normalizeNumber(range.maximum);
  return range;
}

function normalizeList(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value;
  return value;
}

function firstPresent(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function parseRangeFromText(value: unknown, suffix: string): { minimum: number; maximum: number } | null {
  if (Array.isArray(value)) value = value.join(" ");
  if (typeof value !== "string") return null;
  const escapedSuffix = suffix === "L" ? "(?:L|升)" : suffix;
  const match = value.match(new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*(?:[-–—~至到])\\s*([0-9]+(?:\\.[0-9]+)?)\\s*${escapedSuffix}`, "iu"));
  if (!match) return null;
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? { minimum, maximum } : null;
}

function normalizeMealExamples(value: unknown): unknown {
  return pickKnown(value, ["breakfast", "lunch", "dinner", "snack"]) ?? value;
}

function normalizeFoodReference(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = {
    proteinOptions: firstPresent(value, ["proteinOptions", "proteinFoods", "proteinSources", "proteins"]),
    fiberOptions: firstPresent(value, ["fiberOptions", "fiberFoods", "vegetableOptions", "vegetables"]),
    carbOptions: firstPresent(value, ["carbOptions", "carbFoods", "stapleOptions", "stapleFoods", "carbohydrateOptions"]),
    fatOptions: firstPresent(value, ["fatOptions", "fatFoods", "oilOptions", "oilFoods"])
  };
  return Object.fromEntries(Object.entries(normalized)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, normalizeList(item)]));
}

function normalizeSeasonalPoem(value: unknown): unknown {
  if (value === null) return null;
  if (!isRecord(value)) return value;
  const poem = pickKnown(value, ["title", "author", "excerpt", "relevance"]) ?? {};
  const excerpt = poem.excerpt;
  if (typeof excerpt === "string") {
    const knownPoems: Array<{ excerpt: string; title: string; author: string }> = [
      { excerpt: "自古逢秋悲寂寥，我言秋日胜春朝。", title: "秋词", author: "刘禹锡" },
      { excerpt: "空山新雨后，天气晚来秋。", title: "山居秋暝", author: "王维" }
    ];
    const known = knownPoems.find((item) => excerpt.includes(item.excerpt) || item.excerpt.includes(excerpt));
    if (known) {
      poem.title ??= known.title;
      poem.author ??= known.author;
    }
  }
  return poem;
}

function normalizeNutritionTargets(value: unknown, hydrationGuidance: unknown): unknown {
  if (!isRecord(value)) return value;
  const targets: Record<string, unknown> = {};
  const aliases: Record<string, readonly string[]> = {
    carbohydrateGrams: ["carbohydrateGrams", "carbohydrateRangeGrams", "carbGrams", "carbsGrams"],
    fatGrams: ["fatGrams", "fatRangeGrams"],
    fiberGrams: ["fiberGrams", "fiberRangeGrams"],
    hydrationLiters: ["hydrationLiters", "waterLiters", "waterRangeLiters", "hydrationRangeLiters"],
    macroRatioPercent: ["macroRatioPercent", "macroRatio", "macros"]
  };
  for (const [canonical, keys] of Object.entries(aliases)) {
    const item = firstPresent(value, keys);
    if (item !== undefined) targets[canonical] = item;
  }
  if (targets.hydrationLiters === undefined) {
    const parsed = parseRangeFromText(hydrationGuidance, "L");
    if (parsed) targets.hydrationLiters = parsed;
  }
  for (const key of ["carbohydrateGrams", "fatGrams", "fiberGrams", "hydrationLiters"] as const) {
    if (key in targets) targets[key] = normalizeRange(targets[key]);
  }
  if ("macroRatioPercent" in targets) {
    const ratio = pickKnown(targets.macroRatioPercent, ["protein", "carbohydrate", "fat"]);
    if (ratio) {
      for (const key of ["protein", "carbohydrate", "fat"] as const) {
        if (key in ratio) ratio[key] = normalizeNumber(ratio[key]);
      }
      targets.macroRatioPercent = ratio;
    }
  }
  return targets;
}

function neutralMovementReference() {
  return {
    category: "rest" as const,
    durationMinutes: { minimum: 0, maximum: 0 },
    intensity: "rest" as const,
    highIntensity: false,
    safetyReminder: "健康饮食参考不生成训练计划。"
  };
}

function normalizeDay(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const day = pickKnown(value, [
    "nutritionDirection", "proteinRangeGrams", "nutritionTargets", "hydrationGuidance", "mealExamples",
    "proteinRotationSources", "foodReference", "fruitOptions", "plateGuidance", "seasonalVegetables", "seasonalGuidance",
    "seasonalPoem"
  ]) ?? {};
  if (day.hydrationGuidance === undefined) day.hydrationGuidance = firstPresent(value, ["hydration", "waterGuidance"]);
  if (day.plateGuidance === undefined) day.plateGuidance = firstPresent(value, ["plateAdvice", "plate"]);
  if (day.proteinRotationSources === undefined) day.proteinRotationSources = firstPresent(value, ["proteinSources", "proteinRotation"]);
  if (day.seasonalVegetables === undefined) day.seasonalVegetables = firstPresent(value, ["seasonalVegetableOptions"]);
  if (day.fruitOptions === undefined) day.fruitOptions = firstPresent(value, ["fruitOptions", "fruit", "seasonalFruits"]);
  if ("hydrationGuidance" in day) day.hydrationGuidance = normalizeList(day.hydrationGuidance);
  if ("plateGuidance" in day) day.plateGuidance = normalizeList(day.plateGuidance);
  if ("proteinRotationSources" in day) day.proteinRotationSources = normalizeList(day.proteinRotationSources);
  if ("seasonalVegetables" in day) day.seasonalVegetables = normalizeList(day.seasonalVegetables);
  if ("fruitOptions" in day) day.fruitOptions = normalizeList(day.fruitOptions);
  if ("proteinRangeGrams" in day) day.proteinRangeGrams = normalizeRange(day.proteinRangeGrams);
  if ("nutritionTargets" in day) day.nutritionTargets = normalizeNutritionTargets(day.nutritionTargets, day.hydrationGuidance);
  if ("mealExamples" in day) day.mealExamples = normalizeMealExamples(day.mealExamples);
  if ("foodReference" in day) day.foodReference = normalizeFoodReference(day.foodReference);
  if ("seasonalPoem" in day) day.seasonalPoem = normalizeSeasonalPoem(day.seasonalPoem);
  // Existing stored plans retain their movement field for compatibility, but
  // newly generated health references never ask the provider for training.
  day.movement = neutralMovementReference();
  return day;
}

export function normalizeHealthAnswer(value: unknown): unknown {
  const source = unwrapProviderPlan(value);
  const plan = pickKnown(source, ["overview", "supplements", "days"]);
  if (!plan) return value;
  if (Array.isArray(plan.days)) plan.days = plan.days.map((day) => normalizeDay(isRecord(day) && isRecord(day.content) ? day.content : day));
  else if (isRecord(plan.days)) plan.days = Object.values(plan.days).map((day) => normalizeDay(isRecord(day) && isRecord(day.content) ? day.content : day));
  return plan;
}

function unwrapProviderPlan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Object.prototype.hasOwnProperty.call(value, "overview") || Object.prototype.hasOwnProperty.call(value, "days")) return value;
  for (const key of ["plan", "healthPlan", "weeklyPlan", "weekPlan", "data", "result"]) {
    const nested = value[key];
    if (isRecord(nested) && (Object.prototype.hasOwnProperty.call(nested, "overview") || Object.prototype.hasOwnProperty.call(nested, "days"))) return nested;
  }
  return value;
}

function parseAnswerJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error("provider_json_missing_object");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(candidate.slice(start, index + 1));
      }
    }
    throw new Error("provider_json_incomplete");
  }
}


function normalizeSmartQuotes(text: string): string {
  return text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function issuePath(path: Array<string | number>): { machine: string; user: string } {
  const machine = path.map(String).join(".") || "root";
  let prefix = "";
  let fields = path;
  if (path[0] === "days" && typeof path[1] === "number") {
    prefix = `第 ${path[1] + 1} 天`;
    fields = path.slice(2);
  }
  const labels = fields
    .filter((segment): segment is string => typeof segment === "string")
    .map((segment) => FIELD_LABELS[segment] ?? segment);
  const lastSegment = fields[fields.length - 1];
  if (typeof lastSegment === "number") labels.push(`第 ${lastSegment + 1} 项`);
  const label = labels.length > 0 ? labels.join(" / ") : FIELD_LABELS.days;
  return { machine, user: `${prefix}${prefix && label ? "的" : ""}“${label}”` };
}

function issueReason(issue: ZodIssue): string {
  if (issue.code === "invalid_type") {
    const expected = EXPECTED_TYPE_LABELS[issue.expected] ?? issue.expected;
    return issue.received === "undefined" ? "缺少必填字段" : `类型不正确，应为${expected}`;
  }
  if (issue.code === "invalid_enum_value") return "值不在允许范围内";
  if (issue.code === "unrecognized_keys") return "包含未允许的字段";
  if (issue.code === "too_small") return issue.type === "array" ? "条目数量不足" : "数值或文字长度低于允许范围";
  if (issue.code === "too_big") return issue.type === "array" ? "条目数量过多" : "数值或文字长度超过允许范围";
  if (issue.message.includes("minimum cannot exceed maximum")) return "下限不能大于上限";
  if (issue.message.includes("Macro ratio percentages")) return "三项比例合计必须接近 100%";
  if (issue.message.includes("protein conversion")) return "必须给出鸡蛋、牛肉和鸡胸肉的具体换算";
  if (issue.message.includes("food conversion")) return "必须给出熟米饭、白菜和食用油的具体换算";
  if (issue.message.includes("paper cup hydration conversion")) return "必须给出饮水量对应的纸杯数量";
  if (issue.message.startsWith("fruit portion missing: ")) return `未识别到明确份量（原文：${issue.message.slice("fruit portion missing: ".length)}）；请使用如“苹果 1 个”“香蕉 1 根”的写法`;
  if (issue.message.includes("fruit options with portions")) return "水果选项不足两项；每种水果请分别列为一项并注明份量";
  if (issue.message.includes("is required for newly generated")) return "缺少必填字段";
  return "内容不符合候选格式";
}


export type HealthAnswerIssue = { path: string; message: string };
export type HealthAnswerResult =
  | { ok: true; content: HealthPlanContent; relaxed: boolean }
  | { ok: false; stage: "empty" | "json" | "structure"; issues: HealthAnswerIssue[] };

/**
 * 把网页版 AI 的回答变成健康参考内容。优先按完整格式校验（含食物换算、纸杯、
 * 水果份量）；完整格式不过但基础结构正确时也接受，并标记 relaxed 让界面提示。
 */
export function parseHealthAnswer(answer: string): HealthAnswerResult {
  const text = answer.trim();
  if (!text) return { ok: false, stage: "empty", issues: [{ path: "root", message: "还没有粘贴 AI 的回答。" }] };
  let raw: unknown;
  try {
    raw = parseAnswerJson(stripTrailingCommas(normalizeSmartQuotes(text)));
  } catch {
    return { ok: false, stage: "json", issues: [{ path: "root", message: "没有在回答里找到完整的 JSON。请让 AI 只输出一个 ```json 代码块，并确认结尾没有被截断。" }] };
  }
  const normalized = normalizeHealthAnswer(raw);
  const strict = generatedHealthPlanContentSchema.safeParse(normalized);
  if (strict.success) return { ok: true, content: strict.data, relaxed: false };
  const basic = healthPlanContentSchema.safeParse(normalized);
  if (basic.success) return { ok: true, content: basic.data, relaxed: true };
  const seen = new Set<string>();
  const issues: HealthAnswerIssue[] = [];
  for (const issue of basic.error.issues) {
    const path = issuePath(issue.path);
    const message = `${path.user}${issueReason(issue)}`;
    if (seen.has(message)) continue;
    seen.add(message);
    issues.push({ path: path.machine, message });
  }
  return { ok: false, stage: "structure", issues };
}

/** 回答不合格时，生成一段可以直接发回给 AI 的修正说明。 */
export function buildHealthFixPrompt(issues: HealthAnswerIssue[]): string {
  return [
    "你上一次给出的 JSON 没有通过软件的格式检查，请按下面的问题修正后，重新输出完整的 JSON（只要一个 ```json 代码块，不要省略任何一天）：",
    ...issues.slice(0, 12).map((issue, index) => `${index + 1}. ${issue.message}`),
    issues.length > 12 ? `……另有 ${issues.length - 12} 处问题，请对照模板逐项检查。` : ""
  ].filter(Boolean).join("\n");
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function describeProfile(profile: HealthProfile | null): string {
  if (!profile) return "（用户还没有在软件里填写健康资料，请在生成前先问清楚：性别、年龄、身高、体重、日常活动量和主要目标。）";
  const sex = profile.sex === "male" ? "男" : profile.sex === "female" ? "女" : "未说明";
  const bmi = profile.weightKg / ((profile.heightCm / 100) ** 2);
  const lines = [
    `- 性别：${sex}；年龄：${profile.age} 岁`,
    `- 身高 ${profile.heightCm} cm，体重 ${profile.weightKg} kg（BMI 约 ${bmi.toFixed(1)}）`,
    `- 日常活动量：${healthActivityLevelLabels[profile.activityLevel]}`,
    `- 主要目标：${healthGoalLabels[profile.goal]}${profile.targetWeightKg ? `，目标体重约 ${profile.targetWeightKg} kg` : ""}`
  ];
  if (profile.exercise) lines.push(`- 平时的运动：${profile.exercise}`);
  if (profile.eatingContext) lines.push(`- 吃饭主要靠：${healthEatingContextLabels[profile.eatingContext]}`);
  if (profile.likedFoods.length) lines.push(`- 爱吃 / 常吃：${profile.likedFoods.join("、")}`);
  if (profile.avoidFoods.length) lines.push(`- 不吃 / 过敏 / 不适合：${profile.avoidFoods.join("、")}（必须完全避开）`);
  if (profile.bodyNotes) lines.push(`- 身体情况：${profile.bodyNotes}`);
  if (profile.city) lines.push(`- 所在城市：${profile.city}`);
  return lines.join("\n");
}

const dayExample = {
  nutritionDirection: "今天的饮食方向，1-3 句话。",
  proteinRangeGrams: { minimum: 90, maximum: 120 },
  nutritionTargets: {
    carbohydrateGrams: { minimum: 200, maximum: 260 },
    fatGrams: { minimum: 50, maximum: 70 },
    fiberGrams: { minimum: 25, maximum: 35 },
    hydrationLiters: { minimum: 1.8, maximum: 2.4 },
    macroRatioPercent: { protein: 25, carbohydrate: 50, fat: 25 }
  },
  hydrationGuidance: ["2L 水约等于 8 个纸杯（250ml）", "上午、下午分次喝，避免一次喝太多"],
  mealExamples: { breakfast: ["燕麦牛奶 + 鸡蛋 2 个"], lunch: ["米饭 1 碗 + 番茄炒鸡蛋 + 青菜"], dinner: ["鸡胸肉 150 克 + 杂粮饭 + 白菜"], snack: ["酸奶 1 杯"] },
  proteinRotationSources: ["鸡蛋", "鸡胸肉", "豆腐"],
  foodReference: {
    proteinOptions: ["蛋白质目标约等于 6 个鸡蛋", "约等于 400 克牛肉", "约等于 350 克鸡胸肉"],
    fiberOptions: ["约等于 500 克白菜"],
    carbOptions: ["约等于 3 碗熟米饭"],
    fatOptions: ["约等于 3 汤匙食用油"]
  },
  fruitOptions: ["苹果 1 个", "香蕉 1 根"],
  plateGuidance: ["一半蔬菜、四分之一主食、四分之一蛋白质"],
  seasonalVegetables: ["白菜", "萝卜"],
  seasonalGuidance: "时令提示，一句话；没有就写 null。",
  seasonalPoem: { title: "篇名", author: "作者", excerpt: "确定无误的原句", relevance: "与时令的联系" }
};

/**
 * 生成发给网页版 AI 的完整提问模板：包含用户资料、本周日期、规则和 JSON 骨架。
 * extraContext 是用户这周想补充的情况（可空）。
 */
export function buildHealthPromptTemplate(input: { profile: HealthProfile | null; weekStart: string; solarTerm: string; dates: string[]; extraContext?: string }): string {
  const dateLines = input.dates.map((date, index) => `第 ${index + 1} 天：${date}（${WEEKDAY_LABELS[index]}）`).join("\n");
  return [
    "请你帮我生成一份“每周健康饮食参考”。它只是日常参考，不是医疗或营养处方。",
    "",
    "【我的资料】",
    describeProfile(input.profile),
    "",
    `【这一周】从 ${input.weekStart} 开始，节气：${input.solarTerm}`,
    dateLines,
    input.extraContext?.trim() ? `\n【这周的特别情况】\n${input.extraContext.trim()}` : "",
    "",
    "【要求】",
    "只根据我上面给出的资料生成，不要推断性格、体质、疾病或心理状态。",
    "请按我的性别、年龄、体重、活动量和目标分别估算每日范围，不要套用通用模板；如果我写了爱吃的食物、吃饭场景、城市或这周的特别情况，菜单要明显体现出来。",
    "7 天的三餐示例要轮换，同一道菜一周内最多出现两次；训练多或活动多的日子可以适当提高碳水，休息日可以略低，并在 nutritionDirection 里说明原因。",
    "返回 JSON：{overview:string,supplements:string[],days:[7 个日对象]}。",
    HEALTH_PLAN_OUTPUT_CONTRACT,
    "字段名必须严格遵守软件契约：nutritionTargets 使用 carbohydrateGrams、fatGrams、fiberGrams、hydrationLiters、macroRatioPercent；hydrationGuidance 和 plateGuidance 必须是字符串数组；foodReference 必须使用 proteinOptions、fiberOptions、carbOptions、fatOptions；fruitOptions 必须是水果字符串数组；seasonalPoem 有内容时必须同时返回 title、author、excerpt、relevance。不要使用 calories、proteinFoods、stapleFoods、vegetables 或其他同义字段，也不要返回 movement、exercise、training、workout。",
    "饮食是可执行的参考而非硬性处方：给保守范围、三餐与可选加餐的真实食材示例、当天蛋白来源轮换和带数量的食物换算。proteinOptions 必须分别包含目标蛋白质约等于多少个鸡蛋、多少克牛肉、多少克鸡胸肉；carbOptions 必须包含约等于几碗熟米饭；fiberOptions 必须包含约等于多少克白菜；fatOptions 必须包含约等于多少汤匙食用油。hydrationGuidance 必须包含带数字的常见纸杯换算，例如 2L 水约等于 8 个纸杯。所有换算都注明只是便于理解的估算，不要求精确照做。",
    "fruitOptions 每天必须给出至少两种具体水果和建议份量，例如 1 个苹果、200 克草莓；水果独立于正餐和蔬菜展示。优先建议从水果和日常食物获取自然营养，补充剂只用于饮食难以覆盖或用户明确考虑的部分。不得要求打卡，不得把示例写成必须执行。缺少精确资料时必须在 overview 或 nutritionDirection 说明假设。",
    "蛋白质、碳水、脂肪、纤维和饮水使用每日参考范围；hydrationGuidance 给出可选择的分时饮水参考、运动前后调整和避免一次性大量饮水的提示，不计算用户实际饮水量。三大营养素比例总和约为 100。mealExamples 只写正餐与可选加餐的组合，不生成训练计划，不计算用户实际已摄入量，不伪装成完成进度。",
    "用户自己管理训练。不得生成、概括或调整训练计划、动作清单、运动任务、训练时长、强度、重量、配速或排期；也不要在 overview、nutritionDirection、mealExamples、supplements 中夹带这些内容。",
    "节气内容只作为传统饮食文化和时令提示，不做中医体质诊断或治疗宣称。",
    "seasonalPoem 只能选择确有把握的真实古诗词短句；作者、篇名或原句不确定时必须返回 null，禁止杜撰。excerpt 保持简短，relevance 只解释与当天时令或天气的联系。",
    "supplements 只围绕用户资料与饮食场景给补充剂建议，可分别考虑维生素 C、钙、锌、鱼油等类别，先说明哪些营养更适合通过水果、蔬菜、奶类、鱼类等自然食物获得，再写标签、服用时机和成分重复的注意事项；不提供确定剂量、不自动加入肌酸，也不替用户做医疗判断。",
    "",
    "【输出格式】",
    "只输出一个 ```json 代码块，不要任何其他文字。结构如下（days 必须正好 7 项，按上面第 1 天到第 7 天的顺序；下面只示范了 1 天，数字只是示例）：",
    "```json",
    JSON.stringify({ overview: "这一周的整体饮食方向与假设说明。", supplements: ["补充剂提示（不给确定剂量）"], days: [dayExample] }, null, 2),
    "```"
  ].filter((line) => line !== undefined).join("\n");
}
