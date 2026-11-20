import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Check, ChevronLeft, ChevronRight, ClipboardPenLine, Copy, HeartPulse, Leaf, LoaderCircle, MapPin, Quote, Sparkles, X } from "lucide-react";
import { buildHealthFixPrompt, buildHealthPromptTemplate, parseHealthAnswer, type HealthAnswerIssue } from "@personal-ai/domain/health-template";
import { localDatesForHealthWeek, type HealthProfile } from "@personal-ai/domain/health";
import { resolveSolarTerm } from "./solar-terms";
import { PosterMark } from "./ui/poster";

type Profile = {
  city: string | null;
  basics: { sex: "male" | "female" | "other"; age: number; heightCm: number; weightKg: number; bodyFatPercent: number | null; waistCm: number | null };
  goals: string[];
  stageWeightGoal: { minimumKg: number; maximumKg: number };
  considerations: string[];
  activity: { sessionsPerWeek: number; usualDurationMinutes: { minimum: number; maximum: number }; preferredActivities: string[]; avoidHighRisk: boolean };
  food: { mealContext: string; mealTimes: { breakfast: string; lunch: string; dinner: string }; dislikes: string[]; commonFoods: string[] };
  supplements: { current: string[]; considering: string[]; avoids: string[] };
  notes: string | null;
};
type StoredProfile = { id: string; version: number; profile: Profile };
type DayReference = {
  id: string;
  localDate: string;
  dayIndex: number;
  content: {
    nutritionDirection: string;
    proteinRangeGrams: { minimum: number; maximum: number };
    nutritionTargets?: {
      carbohydrateGrams: { minimum: number; maximum: number };
      fatGrams: { minimum: number; maximum: number };
      fiberGrams: { minimum: number; maximum: number };
      hydrationLiters: { minimum: number; maximum: number };
      macroRatioPercent: { protein: number; carbohydrate: number; fat: number };
    };
    hydrationGuidance?: string[];
    mealExamples?: { breakfast: string[]; lunch: string[]; dinner: string[]; snack: string[] };
    proteinRotationSources?: string[];
    foodReference?: { proteinOptions: string[]; fiberOptions: string[]; carbOptions: string[]; fatOptions?: string[] };
    fruitOptions?: string[];
    plateGuidance: string[];
    seasonalVegetables: string[];
    seasonalGuidance?: string | null;
    seasonalPoem?: { title: string; author: string; excerpt: string; relevance: string } | null;
    movement: { category: "strength" | "volleyball" | "running" | "walking" | "cycling" | "recovery" | "rest"; durationMinutes: { minimum: number; maximum: number }; intensity: "rest" | "low" | "moderate" | "high"; highIntensity: boolean; safetyReminder: string; focus?: string[]; safetyNotes?: string[] };
  };
};
type HealthPlan = {
  id: string;
  weekStart: string;
  state: "candidate" | "active";
  source: "template" | "ai" | "manual";
  city: string | null;
  solarTerm: string;
  overview: string;
  supplements: string[];
  version: number;
  basedOnPlanId: string | null;
  basedOnPlanVersion: number | null;
  sourceSleepAnalysisId: string | null;
  revisionReason: string | null;
  days: DayReference[];
};
type ManualNumber = number | "";
type ManualNutritionTargets = {
  carbohydrateGrams: { minimum: ManualNumber; maximum: ManualNumber };
  fatGrams: { minimum: ManualNumber; maximum: ManualNumber };
  fiberGrams: { minimum: ManualNumber; maximum: ManualNumber };
  hydrationLiters: { minimum: ManualNumber; maximum: ManualNumber };
  macroRatioPercent: { protein: ManualNumber; carbohydrate: ManualNumber; fat: ManualNumber };
};
type ManualDayDraft = Omit<DayReference["content"], "nutritionTargets"> & { nutritionTargets?: ManualNutritionTargets };
type ManualPlanDraft = { overview: string; supplements: string; days: ManualDayDraft[] };
type ApiError = Error & { status?: number; body?: { error?: string; message?: string } };

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function weekStartFor(date: string): string {
  const current = new Date(`${date}T00:00:00.000Z`);
  current.setUTCDate(current.getUTCDate() - current.getUTCDay());
  return current.toISOString().slice(0, 10);
}

function addDays(date: string, count: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function listText(value: string) {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
}

function draftLines(value: string) {
  return value.split("\n");
}

function rangeText(range: { minimum: number; maximum: number } | undefined, suffix = "g") {
  return range ? `${range.minimum}–${range.maximum}${suffix}` : "当前参考未提供";
}

function approximateSpan(minimum: number, maximum: number, divisor: number, digits = 0) {
  const factor = 10 ** digits;
  const format = (value: number) => String(Math.round(value * factor) / factor);
  return `${format(minimum / divisor)}–${format(maximum / divisor)}`;
}

function concreteFoodReference(
  tone: string,
  range: { minimum: number; maximum: number } | undefined,
  options: string[] | undefined,
) {
  const concrete = options?.filter((item) => /\d/u.test(item));
  if (concrete?.length) return concrete.slice(0, 3).join("；");
  if (!range) return "当前参考未提供具体换算";
  if (tone === "protein") return `约 ${approximateSpan(range.minimum, range.maximum, 6)} 个鸡蛋，或 ${approximateSpan(range.minimum, range.maximum, 0.26)} 克牛肉，或 ${approximateSpan(range.minimum, range.maximum, 0.31)} 克鸡胸肉`;
  if (tone === "carb") return `约 ${approximateSpan(range.minimum, range.maximum, 42, 1)} 碗熟米饭（按每碗约 150g 估算）`;
  if (tone === "fat") return `约 ${approximateSpan(range.minimum, range.maximum, 13.5, 1)} 汤匙食用油（仅作换算）`;
  if (tone === "fiber") return `约 ${approximateSpan(range.minimum, range.maximum, 0.025)} 克白菜（仅作换算，通常由多种食物共同获得）`;
  if (tone === "water") return `约 ${approximateSpan(range.minimum, range.maximum, 0.25)} 个 250ml 纸杯`;
  return "当前参考未提供具体换算";
}

const REFERENCE_SCALE_LIMITS:Record<string,{minimum:number;maximum:number}> = {
  protein:{minimum:0,maximum:200}, carb:{minimum:0,maximum:500}, fat:{minimum:0,maximum:150}, fiber:{minimum:0,maximum:60}, water:{minimum:0,maximum:5}
};
function referenceScale(label: string, range: { minimum: number; maximum: number } | undefined, tone: string, reference: string, suffix = "g") {
  const limits=REFERENCE_SCALE_LIMITS[tone]??{minimum:0,maximum:100};
  const span=Math.max(1,limits.maximum-limits.minimum);
  const start=range?Math.max(0,Math.min(100,(range.minimum-limits.minimum)/span*100)):0;
  const end=range?Math.max(start,Math.min(100,(range.maximum-limits.minimum)/span*100)):0;
  const midpoint=(start+end)/2;
  return <div className="health-target-row" data-tone={tone} data-has-range={range?"true":"false"} style={{"--range-start":`${start}%`,"--range-width":`${end-start}%`,"--range-mid":`${midpoint}%`} as CSSProperties}><span>{label}</span><strong>{rangeText(range, suffix)}</strong><i aria-hidden="true"><b /></i><small>{reference}</small></div>;
}

function listOrMissing(items: string[] | undefined, className?: string) {
  return items?.length ? <ul className={className}>{items.map((item)=><li key={item}>{item}</li>)}</ul> : <p className="health-field-missing">当前参考未提供；重新生成候选后可补齐。</p>;
}




function revisionChanges(previous: DayReference, next: DayReference): string[] {
  const changes: string[] = [];
  if (previous.content.nutritionDirection !== next.content.nutritionDirection) changes.push("饮食方向已调整");
  if (previous.content.proteinRangeGrams.minimum !== next.content.proteinRangeGrams.minimum || previous.content.proteinRangeGrams.maximum !== next.content.proteinRangeGrams.maximum) {
    changes.push(`蛋白质：${previous.content.proteinRangeGrams.minimum}–${previous.content.proteinRangeGrams.maximum} g -> ${next.content.proteinRangeGrams.minimum}–${next.content.proteinRangeGrams.maximum} g`);
  }
  if (previous.content.plateGuidance.join("\n") !== next.content.plateGuidance.join("\n")) changes.push("餐盘提示已调整");
  if (JSON.stringify(previous.content.nutritionTargets ?? null) !== JSON.stringify(next.content.nutritionTargets ?? null)) changes.push("营养目标范围已调整");
  if (JSON.stringify(previous.content.mealExamples ?? null) !== JSON.stringify(next.content.mealExamples ?? null)) changes.push("三餐示例已调整");
  if (JSON.stringify(previous.content.proteinRotationSources ?? null) !== JSON.stringify(next.content.proteinRotationSources ?? null)) changes.push("蛋白轮换已调整");
  if (JSON.stringify(previous.content.foodReference ?? null) !== JSON.stringify(next.content.foodReference ?? null)) changes.push("替代食材参考已调整");
  if (JSON.stringify(previous.content.fruitOptions ?? null) !== JSON.stringify(next.content.fruitOptions ?? null)) changes.push("水果选择已调整");
  if (previous.content.seasonalVegetables.join("\n") !== next.content.seasonalVegetables.join("\n")) changes.push("时令蔬菜提示已调整");
  if ((previous.content.seasonalGuidance ?? null) !== (next.content.seasonalGuidance ?? null)) changes.push("时令生活提示已调整");
  if (JSON.stringify(previous.content.seasonalPoem ?? null) !== JSON.stringify(next.content.seasonalPoem ?? null)) changes.push("时令诗词已调整");
  return changes;
}

function planRevisionChanges(previous: HealthPlan, next: HealthPlan): string[] {
  const changes: string[] = [];
  if (previous.overview !== next.overview) changes.push("本周概览已调整");
  if (previous.supplements.join("\n") !== next.supplements.join("\n")) changes.push("补充剂建议已调整");
  if (previous.city !== next.city) changes.push(`城市参考：${previous.city ?? "未设置"} -> ${next.city ?? "未设置"}`);
  if (previous.solarTerm !== next.solarTerm) changes.push(`节气参考：${previous.solarTerm} -> ${next.solarTerm}`);
  return changes;
}

function manualDraftFromPlan(plan: HealthPlan): ManualPlanDraft {
  return {
    overview: plan.overview,
    supplements: plan.supplements.join("\n"),
    days: plan.days.map((day) => ({
      ...day.content,
      proteinRangeGrams: { ...day.content.proteinRangeGrams },
      nutritionTargets: day.content.nutritionTargets ? {
        carbohydrateGrams: { ...day.content.nutritionTargets.carbohydrateGrams },
        fatGrams: { ...day.content.nutritionTargets.fatGrams },
        fiberGrams: { ...day.content.nutritionTargets.fiberGrams },
        hydrationLiters: { ...day.content.nutritionTargets.hydrationLiters },
        macroRatioPercent: { ...day.content.nutritionTargets.macroRatioPercent }
      } : undefined,
      hydrationGuidance: day.content.hydrationGuidance ? [...day.content.hydrationGuidance] : undefined,
      mealExamples: day.content.mealExamples ? {
        breakfast: [...day.content.mealExamples.breakfast], lunch: [...day.content.mealExamples.lunch], dinner: [...day.content.mealExamples.dinner], snack: [...day.content.mealExamples.snack]
      } : undefined,
      proteinRotationSources: day.content.proteinRotationSources ? [...day.content.proteinRotationSources] : undefined,
      foodReference: day.content.foodReference ? {
        proteinOptions: [...day.content.foodReference.proteinOptions], fiberOptions: [...day.content.foodReference.fiberOptions], carbOptions: [...day.content.foodReference.carbOptions], fatOptions: day.content.foodReference.fatOptions ? [...day.content.foodReference.fatOptions] : undefined
      } : undefined,
      fruitOptions: day.content.fruitOptions ? [...day.content.fruitOptions] : undefined,
      plateGuidance: [...day.content.plateGuidance],
      seasonalVegetables: [...day.content.seasonalVegetables],
      seasonalGuidance: day.content.seasonalGuidance ?? null,
      seasonalPoem: day.content.seasonalPoem ? { ...day.content.seasonalPoem } : null,
      movement: { ...day.content.movement, durationMinutes: { ...day.content.movement.durationMinutes }, focus: day.content.movement.focus ? [...day.content.movement.focus] : undefined, safetyNotes: day.content.movement.safetyNotes ? [...day.content.movement.safetyNotes] : undefined }
    }))
  };
}

function emptyManualNutritionTargets(): ManualNutritionTargets {
  return {
    carbohydrateGrams: { minimum: "", maximum: "" },
    fatGrams: { minimum: "", maximum: "" },
    fiberGrams: { minimum: "", maximum: "" },
    hydrationLiters: { minimum: "", maximum: "" },
    macroRatioPercent: { protein: "", carbohydrate: "", fat: "" }
  };
}

function manualNumber(value: string): ManualNumber {
  return value === "" ? "" : Number(value);
}

function completeManualNutritionTargets(targets: ManualNutritionTargets | undefined) {
  if (!targets) return undefined;
  const values = [
    targets.carbohydrateGrams.minimum, targets.carbohydrateGrams.maximum,
    targets.fatGrams.minimum, targets.fatGrams.maximum,
    targets.fiberGrams.minimum, targets.fiberGrams.maximum,
    targets.hydrationLiters.minimum, targets.hydrationLiters.maximum,
    targets.macroRatioPercent.protein, targets.macroRatioPercent.carbohydrate, targets.macroRatioPercent.fat
  ];
  if (values.some((value) => value === "")) throw new Error("manual_nutrition_targets_incomplete");
  return {
    carbohydrateGrams: { minimum: Number(targets.carbohydrateGrams.minimum), maximum: Number(targets.carbohydrateGrams.maximum) },
    fatGrams: { minimum: Number(targets.fatGrams.minimum), maximum: Number(targets.fatGrams.maximum) },
    fiberGrams: { minimum: Number(targets.fiberGrams.minimum), maximum: Number(targets.fiberGrams.maximum) },
    hydrationLiters: { minimum: Number(targets.hydrationLiters.minimum), maximum: Number(targets.hydrationLiters.maximum) },
    macroRatioPercent: { protein: Number(targets.macroRatioPercent.protein), carbohydrate: Number(targets.macroRatioPercent.carbohydrate), fat: Number(targets.macroRatioPercent.fat) }
  };
}

async function request<T>(path: string, method = "GET", payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { method, headers: payload ? { "content-type": "application/json" } : undefined, body: payload ? JSON.stringify(payload) : undefined });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((body as { error?: string }).error ?? `HTTP ${response.status}`) as ApiError;
    error.status = response.status;
    error.body = body as { error?: string };
    throw error;
  }
  return body as T;
}


export function HealthWorkspace() {
  const [weekStart, setWeekStart] = useState(() => weekStartFor(shanghaiDate()));
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [active, setActive] = useState<HealthPlan | null>(null);
  const [candidate, setCandidate] = useState<HealthPlan | null>(null);
  const [selectedDay, setSelectedDay] = useState(0);
  const [answerText, setAnswerText] = useState("");
  const [weekContext, setWeekContext] = useState("");
  const [answerIssues, setAnswerIssues] = useState<HealthAnswerIssue[]>([]);
  const [copied, setCopied] = useState<"template" | "fix" | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualPlanDraft | null>(null);
  const candidateSectionRef = useRef<HTMLElement | null>(null);
  const reloadRequestRef = useRef(0);
  const visiblePlan = candidate ?? active;
  const selectedReference = visiblePlan?.days[selectedDay] ?? null;
  useEffect(() => { void reload(); }, [weekStart]);
  useEffect(() => {
    const resumeCollaboration = () => {
      if (!document.hidden) void reload();
    };
    window.addEventListener("focus", resumeCollaboration);
    document.addEventListener("visibilitychange", resumeCollaboration);
    return () => {
      window.removeEventListener("focus", resumeCollaboration);
      document.removeEventListener("visibilitychange", resumeCollaboration);
    };
  }, [weekStart]);
  useEffect(() => { setAnswerText(""); setAnswerIssues([]); setWeekContext(""); }, [weekStart]);

  async function reload() {
    const requestId = ++reloadRequestRef.current;
    setLoading(true);
    try {
      const [profileResult, weekResult] = await Promise.all([
        request<{ profile: StoredProfile | null }>("/api/v1/health/profile"),
        request<{ active: HealthPlan | null; candidate: HealthPlan | null }>(`/api/v1/health/weeks/${weekStart}`)
      ]);
      if (requestId !== reloadRequestRef.current) return;
      setProfile(profileResult.profile);
      setActive(weekResult.active);
      setCandidate(weekResult.candidate);
      setSelectedDay(0);
      setError(null);
    } catch {
      if (requestId !== reloadRequestRef.current) return;
      setError("健康参考暂时无法读取，请确认本机 API 正在运行。");
    } finally {
      if (requestId === reloadRequestRef.current) setLoading(false);
    }
  }





  async function copyText(text: string, kind: "template" | "fix") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older WebViews: fall back to a hidden textarea.
      const area = document.createElement("textarea");
      area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select();
      document.execCommand("copy"); area.remove();
    }
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 2200);
  }

  async function copyTemplate() {
    const template = buildHealthPromptTemplate({
      profile: (profile?.profile ?? null) as HealthProfile | null,
      weekStart,
      solarTerm: resolveSolarTerm(weekStart).term,
      dates: localDatesForHealthWeek(weekStart),
      extraContext: weekContext
    });
    await copyText(template, "template");
  }

  async function copyFixPrompt() {
    await copyText(buildHealthFixPrompt(answerIssues), "fix");
  }

  /** Check the pasted AI answer with code, then store it as an unconfirmed candidate. */
  async function importAnswer() {
    const parsed = parseHealthAnswer(answerText);
    if (!parsed.ok) { setAnswerIssues(parsed.issues); return; }
    setAnswerIssues([]);
    setBusy(true); setError(null);
    try {
      const result = await request<{ plan: HealthPlan }>("/api/v1/health/weeks/manual-candidates", "POST", {
        weekStart,
        specialContext: weekContext.trim() || null,
        content: parsed.content
      });
      setCandidate(result.plan); setSelectedDay(0); setAnswerText("");
      window.requestAnimationFrame(() => candidateSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      setError(code === "health_profile_required" ? "请先保存健康资料，再生成本周参考。" : "候选没有保存，原有参考保持不变。请稍后重试。");
    } finally { setBusy(false); }
  }

  async function confirmCandidate() {
    if (!candidate) return;
    setBusy(true); setError(null);
    try {
      const result = await request<{ plan: HealthPlan }>(`/api/v1/health/weeks/${candidate.id}/confirm`, "POST", { expectedVersion: candidate.version });
      setActive(result.plan); setCandidate(null);
    } catch (requestError) {
      const code = requestError instanceof Error ? (requestError as ApiError).body?.error : undefined;
      if (code === "health_plan_base_changed" || code === "health_profile_version_conflict") {
        await reload();
        setError(code === "health_plan_base_changed" ? "生效版本已经变化，这份旧候选没有覆盖新内容。请重新生成修订候选。" : "健康资料已经更新，这份旧候选没有生效。请基于最新资料重新生成。");
      } else setError("确认失败，候选仍保留。请刷新后重试。");
    }
    finally { setBusy(false); }
  }

  async function discardCandidate() {
    if (!candidate) return;
    setBusy(true); setError(null);
    try {
      await request(`/api/v1/health/weeks/${candidate.id}/cancel`, "POST", { expectedVersion: candidate.version });
      setCandidate(null);
    } catch { setError("放弃候选失败，候选仍保留。请刷新后重试。"); }
    finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optionalNumber = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value ? Number(value) : null;
    };
    const next: Profile = {
      city: String(form.get("city") ?? "").trim() || null,
      basics: {
        sex: String(form.get("sex")) as Profile["basics"]["sex"],
        age: Number(form.get("age")),
        heightCm: Number(form.get("heightCm")),
        weightKg: Number(form.get("weightKg")),
        bodyFatPercent: optionalNumber("bodyFatPercent"),
        waistCm: optionalNumber("waistCm")
      },
      goals: listText(String(form.get("goals") ?? "")),
      stageWeightGoal: { minimumKg: Number(form.get("stageWeightMinimumKg")), maximumKg: Number(form.get("stageWeightMaximumKg")) },
      considerations: listText(String(form.get("considerations") ?? "")),
      activity: {
        sessionsPerWeek: Number(form.get("sessionsPerWeek")),
        usualDurationMinutes: { minimum: Number(form.get("usualDurationMinimum")), maximum: Number(form.get("usualDurationMaximum")) },
        preferredActivities: listText(String(form.get("preferredActivities") ?? "")),
        avoidHighRisk: form.get("avoidHighRisk") === "on"
      },
      food: {
        mealContext: String(form.get("mealContext") ?? "").trim(),
        mealTimes: {
          breakfast: String(form.get("breakfastTime") ?? "").trim(),
          lunch: String(form.get("lunchTime") ?? "").trim(),
          dinner: String(form.get("dinnerTime") ?? "").trim()
        },
        dislikes: listText(String(form.get("dislikes") ?? "")),
        commonFoods: listText(String(form.get("commonFoods") ?? ""))
      },
      supplements: {
        current: listText(String(form.get("currentSupplements") ?? "")),
        considering: listText(String(form.get("consideringSupplements") ?? "")),
        avoids: listText(String(form.get("avoidsSupplements") ?? ""))
      },
      notes: String(form.get("notes") ?? "").trim() || null
    };
    setBusy(true); setError(null);
    try {
      const result = await request<{ profile: StoredProfile }>("/api/v1/health/profile", "PUT", { expectedVersion: profile?.version ?? null, profile: next });
      setProfile(result.profile); setEditingProfile(false);
    } catch { setError("资料保存失败，原资料没有被覆盖。请刷新后重试。"); }
    finally { setBusy(false); }
  }







  function openManualEditor() {
    const source = candidate ?? active;
    if (!source) return;
    setManualDraft(manualDraftFromPlan(source));
    setSelectedDay(0);
    setError(null);
  }

  function updateManualDay(patch: Partial<ManualDayDraft>) {
    setManualDraft((current) => {
      if (!current) return current;
      const days = [...current.days];
      days[selectedDay] = { ...days[selectedDay]!, ...patch };
      return { ...current, days };
    });
  }

  function updateManualNutritionTargets(patch: (current: ManualNutritionTargets) => ManualNutritionTargets) {
    setManualDraft((current) => {
      if (!current) return current;
      const days = [...current.days];
      const day = days[selectedDay]!;
      days[selectedDay] = { ...day, nutritionTargets: patch(day.nutritionTargets ?? emptyManualNutritionTargets()) };
      return { ...current, days };
    });
  }

  function updateManualPoem(patch: Partial<NonNullable<DayReference["content"]["seasonalPoem"]>>) {
    const current = manualDraft?.days[selectedDay]?.seasonalPoem ?? { title: "", author: "", excerpt: "", relevance: "" };
    updateManualDay({ seasonalPoem: { ...current, ...patch } });
  }

  async function saveManualCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manualDraft) return;
    setBusy(true); setError(null);
    try {
      const content = {
        ...manualDraft,
        overview: manualDraft.overview.trim(),
        supplements: listText(manualDraft.supplements),
        days: manualDraft.days.map((day) => ({
          ...day,
          nutritionTargets: completeManualNutritionTargets(day.nutritionTargets),
          mealExamples: day.mealExamples ? {
            breakfast: listText(day.mealExamples.breakfast.join("\n")),
            lunch: listText(day.mealExamples.lunch.join("\n")),
            dinner: listText(day.mealExamples.dinner.join("\n")),
            snack: listText(day.mealExamples.snack.join("\n"))
          } : undefined,
          proteinRotationSources: day.proteinRotationSources?.length ? listText(day.proteinRotationSources.join("\n")) : undefined,
          foodReference: day.foodReference ? {
            proteinOptions: listText(day.foodReference.proteinOptions.join("\n")),
            fiberOptions: listText(day.foodReference.fiberOptions.join("\n")),
            carbOptions: listText(day.foodReference.carbOptions.join("\n")),
            fatOptions: day.foodReference.fatOptions?.length ? listText(day.foodReference.fatOptions.join("\n")) : undefined
          } : undefined,
          fruitOptions: day.fruitOptions?.length ? listText(day.fruitOptions.join("\n")) : undefined,
          plateGuidance: listText(day.plateGuidance.join("\n")),
          seasonalVegetables: listText(day.seasonalVegetables.join("\n")),
          seasonalGuidance: day.seasonalGuidance?.trim() || null,
          seasonalPoem: day.seasonalPoem?.excerpt.trim()
            ? {
                title: day.seasonalPoem.title.trim(),
                author: day.seasonalPoem.author.trim(),
                excerpt: day.seasonalPoem.excerpt.trim(),
                relevance: day.seasonalPoem.relevance.trim()
              }
            : null,
          movement: {
            ...day.movement,
            focus: day.movement.focus?.length ? listText(day.movement.focus.join("\n")) : undefined,
            safetyNotes: day.movement.safetyNotes?.length ? listText(day.movement.safetyNotes.join("\n")) : undefined
          }
        }))
      };
      const result = candidate
        ? await request<{ plan: HealthPlan }>(`/api/v1/health/weeks/${candidate.id}/manual-candidate`, "PUT", { expectedVersion: candidate.version, content })
        : await request<{ plan: HealthPlan }>("/api/v1/health/weeks/manual-candidates", "POST", { weekStart, content });
      setCandidate(result.plan);
      setManualDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error && saveError.message === "manual_nutrition_targets_incomplete"
        ? "营养目标已启用，请把碳水、脂肪、纤维、饮水和三大营养素比例填写完整；也可以关闭这一组目标。"
        : "手动候选保存失败，当前生效参考没有被覆盖。请检查范围、必填列表和三大营养素比例后重试。");
    } finally { setBusy(false); }
  }


  return <section className="health-workspace">
    <header className="health-heading poster-header"><PosterMark word="健康" />
      <div><p className="section-kicker">健康参考</p><h1>周笺定方向，日处方给参考。</h1></div>
      <div className="health-week-switcher"><button type="button" disabled={busy} aria-label="上一周健康参考" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft /></button><div><strong>{weekStart} 起</strong><small>周日到周六</small></div><button type="button" disabled={busy} aria-label="下一周健康参考" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight /></button></div>
    </header>
    {error && <div className="error-banner" role="alert"><X />{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X /></button></div>}
    {loading ? <div className="health-loading"><LoaderCircle className="spin" /><span>正在读取本周健康参考</span></div> : <>
      <section className="health-context-card">
          <div className="health-context-icon"><HeartPulse /></div>
        <div><p className="section-kicker">你的资料</p><strong>{profile ? `${profile.profile.basics.heightCm} cm · ${profile.profile.basics.weightKg} kg · ${profile.profile.goals.slice(0, 2).join(" / ")}` : "尚未建立健康资料"}</strong><small><MapPin />{profile?.profile.city ?? "未设置城市"}</small></div>
        <button className="quiet-button" type="button" onClick={() => setEditingProfile((value) => !value)}><ClipboardPenLine />{editingProfile ? "收起资料" : profile ? "查看或修改资料" : "填写健康资料"}</button>
      </section>
      {editingProfile && <form className="health-profile-form" onSubmit={saveProfile}>
        <h3 className="wide">基础资料</h3>
        <label><span>当前城市（可留空）</span><input name="city" defaultValue={profile?.profile.city ?? ""} maxLength={120} placeholder="例如：输入城市名称" /></label>
        <label><span>性别</span><select name="sex" defaultValue={profile?.profile.basics.sex}><option value="male">男</option><option value="female">女</option><option value="other">其他</option></select></label>
        <label><span>年龄</span><input name="age" type="number" min="16" max="120" step="1" defaultValue={profile?.profile.basics.age} required /></label>
        <label><span>身高（cm）</span><input name="heightCm" type="number" min="120" max="230" step="1" defaultValue={profile?.profile.basics.heightCm} required /></label>
        <label><span>当前体重（kg）</span><input name="weightKg" type="number" min="30" max="300" step="0.1" defaultValue={profile?.profile.basics.weightKg} required /></label>
        <label><span>体脂率（%）</span><input name="bodyFatPercent" type="number" min="1" max="70" step="0.1" defaultValue={profile?.profile.basics.bodyFatPercent ?? ""} /></label>
        <label><span>腰围（cm）</span><input name="waistCm" type="number" min="40" max="200" step="0.1" defaultValue={profile?.profile.basics.waistCm ?? ""} /></label>
        <label className="wide"><span>当前目标（逗号或换行分隔）</span><textarea name="goals" rows={2} defaultValue={profile?.profile.goals?.join("，")} required /></label>
        <label><span>阶段目标下限（kg）</span><input name="stageWeightMinimumKg" type="number" min="30" max="300" step="0.1" defaultValue={profile?.profile.stageWeightGoal.minimumKg} required /></label>
        <label><span>阶段目标上限（kg）</span><input name="stageWeightMaximumKg" type="number" min="30" max="300" step="0.1" defaultValue={profile?.profile.stageWeightGoal.maximumKg} required /></label>
        <label className="wide"><span>需要考虑的情况（逗号或换行分隔）</span><textarea name="considerations" rows={3} defaultValue={profile?.profile.considerations?.join("\n")} required /></label>
        <h3 className="wide">活动偏好</h3>
        <label><span>每周活动次数</span><input name="sessionsPerWeek" type="number" min="0" max="14" step="1" defaultValue={profile?.profile.activity.sessionsPerWeek} required /></label>
        <label><span>单次时长下限（分钟）</span><input name="usualDurationMinimum" type="number" min="0" max="360" step="1" defaultValue={profile?.profile.activity.usualDurationMinutes.minimum} required /></label>
        <label><span>单次时长上限（分钟）</span><input name="usualDurationMaximum" type="number" min="0" max="480" step="1" defaultValue={profile?.profile.activity.usualDurationMinutes.maximum} required /></label>
        <label className="wide"><span>偏好的活动（逗号或换行分隔）</span><textarea name="preferredActivities" rows={2} defaultValue={profile?.profile.activity.preferredActivities?.join("，")} /></label>
        <label className="health-checkbox wide"><input name="avoidHighRisk" type="checkbox" defaultChecked={profile?.profile.activity.avoidHighRisk} /><span>避免高风险或容易受伤的活动建议</span></label>
        <h3 className="wide">饮食与补充剂</h3>
        <label className="wide"><span>用餐场景</span><textarea name="mealContext" rows={2} defaultValue={profile?.profile.food.mealContext} required /></label>
        <label><span>早餐时间</span><input name="breakfastTime" type="time" defaultValue={profile?.profile.food.mealTimes.breakfast} required /></label>
        <label><span>午餐时间</span><input name="lunchTime" type="time" defaultValue={profile?.profile.food.mealTimes.lunch} required /></label>
        <label><span>晚餐时间</span><input name="dinnerTime" type="time" defaultValue={profile?.profile.food.mealTimes.dinner} required /></label>
        <label className="wide"><span>不喜欢或不适合的食物（逗号或换行分隔）</span><textarea name="dislikes" rows={2} defaultValue={profile?.profile.food.dislikes?.join("，")} /></label>
        <label className="wide"><span>常见食物（逗号或换行分隔）</span><textarea name="commonFoods" rows={3} defaultValue={profile?.profile.food.commonFoods?.join("，")} /></label>
        <label><span>当前补充剂</span><textarea name="currentSupplements" rows={2} defaultValue={profile?.profile.supplements.current?.join("，")} /></label>
        <label><span>未来考虑的补充剂</span><textarea name="consideringSupplements" rows={2} defaultValue={profile?.profile.supplements.considering?.join("，")} /></label>
        <label><span>不使用的补充剂</span><textarea name="avoidsSupplements" rows={2} defaultValue={profile?.profile.supplements.avoids?.join("，")} /></label>
        <label className="wide"><span>补充说明（可选）</span><textarea name="notes" rows={2} defaultValue={profile?.profile.notes ?? ""} maxLength={2000} /></label>
        <footer className="wide"><button className="primary-button" disabled={busy} type="submit">{busy ? <LoaderCircle className="spin" /> : <Check />}保存我主动填写的资料</button></footer>
      </form>}
      <section className="health-template" aria-labelledby="health-template-title">
        <header>
          <div><p className="section-kicker">本周参考 · 不用 API 密钥</p><h2 id="health-template-title">{candidate ? "候选尚未生效" : active ? "当前参考保持稳定" : "用网页版 AI 生成本周参考"}</h2></div>
          <button className="quiet-button" type="button" disabled={busy || !profile || !visiblePlan} onClick={openManualEditor}><ClipboardPenLine />手动编辑候选</button>
        </header>
        <ol className="health-template-steps">
          <li>
            <span className="health-template-step">01</span>
            <div>
              <strong>复制提问模板</strong>
              <p>模板里已经带上你的健康资料、本周日期和固定的回答格式。发给任意网页版 AI（DeepSeek、Kimi、豆包、ChatGPT 都可以）。</p>
              <label><span>这周的特别情况（可选，会写进模板）</span><textarea aria-label="这周的特别情况" rows={2} maxLength={1000} value={weekContext} onChange={(event) => setWeekContext(event.target.value)} placeholder="例如：周三出差、这周想少吃外卖" /></label>
              <div className="health-template-actions">
                <button className="primary-button" type="button" disabled={!profile} onClick={() => void copyTemplate()}>{copied === "template" ? <Check /> : <Copy />}{copied === "template" ? "已复制提问模板" : "复制提问模板"}</button>
                {!profile && <small>请先在上面保存你的健康资料。</small>}
              </div>
            </div>
          </li>
          <li>
            <span className="health-template-step">02</span>
            <div>
              <strong>把 AI 的回答整段粘贴回来</strong>
              <p>直接全选复制 AI 的回答即可，软件会自己找出其中的内容并逐项检查。</p>
              <label><span>AI 的回答</span><textarea aria-label="AI 的回答" rows={6} value={answerText} onChange={(event) => { setAnswerText(event.target.value); setAnswerIssues([]); }} placeholder="在这里粘贴网页版 AI 的完整回答……" /></label>
              <div className="health-template-actions">
                <button className="primary-button" type="button" disabled={busy || !profile || !answerText.trim()} onClick={() => void importAnswer()}>{busy ? <LoaderCircle className="spin" /> : <Check />}检查并生成候选</button>
              </div>
              {answerIssues.length > 0 && <div className="health-template-issues" role="alert">
                <strong>这份回答还有 {answerIssues.length} 处不符合格式，没有保存：</strong>
                <ul>{answerIssues.slice(0, 6).map((issue) => <li key={issue.path + issue.message}>{issue.message}</li>)}</ul>
                <button className="quiet-button" type="button" onClick={() => void copyFixPrompt()}>{copied === "fix" ? <Check /> : <Copy />}{copied === "fix" ? "已复制修正说明" : "复制修正说明发回给 AI"}</button>
              </div>}
            </div>
          </li>
          <li>
            <span className="health-template-step">03</span>
            <div><strong>确认后生效</strong><p>检查通过会先生成一份待确认候选，显示在下面。你确认之前，本周已生效的参考不会被替换。</p></div>
          </li>
        </ol>
      </section>
      {manualDraft && <form className="health-manual-editor" onSubmit={saveManualCandidate}>
        <header><div><p className="section-kicker">手动周参考候选</p><h2>你决定每一项内容。</h2><small>保存后只会形成待确认候选，不会立即覆盖当前生效版本。</small></div><button className="quiet-button" type="button" disabled={busy} onClick={() => setManualDraft(null)}>取消编辑</button></header>
        <label><span>本周概览</span><textarea value={manualDraft.overview} onChange={(event) => setManualDraft((current) => current ? { ...current, overview: event.target.value } : current)} rows={3} maxLength={2000} required /></label>
        <label><span>补充剂建议（逗号或换行分隔）</span><textarea value={manualDraft.supplements} onChange={(event) => setManualDraft((current) => current ? { ...current, supplements: event.target.value } : current)} rows={2} /></label>
        <div className="health-manual-days" role="tablist" aria-label="手动编辑的日期">{manualDraft.days.map((_, dayIndex) => <button key={dayIndex} role="tab" aria-selected={selectedDay === dayIndex} className={selectedDay === dayIndex ? "active" : ""} type="button" onClick={() => setSelectedDay(dayIndex)}><span>{weekday[dayIndex]}</span><strong>{String(dayIndex + 1).padStart(2, "0")}</strong></button>)}</div>
        {manualDraft.days[selectedDay] && <section className="health-manual-day-fields">
          <label className="wide"><span>{weekday[selectedDay]}饮食方向</span><textarea value={manualDraft.days[selectedDay]!.nutritionDirection} onChange={(event) => updateManualDay({ nutritionDirection: event.target.value })} rows={3} maxLength={700} required /></label>
          <label><span>蛋白质下限（g）</span><input type="number" min="1" max="300" value={manualDraft.days[selectedDay]!.proteinRangeGrams.minimum} onChange={(event) => updateManualDay({ proteinRangeGrams: { ...manualDraft.days[selectedDay]!.proteinRangeGrams, minimum: Number(event.target.value) } })} required /></label>
          <label><span>蛋白质上限（g）</span><input type="number" min="1" max="300" value={manualDraft.days[selectedDay]!.proteinRangeGrams.maximum} onChange={(event) => updateManualDay({ proteinRangeGrams: { ...manualDraft.days[selectedDay]!.proteinRangeGrams, maximum: Number(event.target.value) } })} required /></label>
          <fieldset className="health-manual-fieldset wide">
            <legend>每日营养目标（可选）</legend>
            <label className="health-checkbox health-manual-toggle"><input type="checkbox" checked={Boolean(manualDraft.days[selectedDay]!.nutritionTargets)} onChange={(event) => updateManualDay({ nutritionTargets: event.target.checked ? emptyManualNutritionTargets() : undefined })} /><span>为当天填写碳水、脂肪、纤维、饮水和比例参考</span></label>
            {manualDraft.days[selectedDay]!.nutritionTargets && <div className="health-manual-grid">
              <label><span>碳水下限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.carbohydrateGrams.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, carbohydrateGrams: { ...targets.carbohydrateGrams, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>碳水上限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.carbohydrateGrams.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, carbohydrateGrams: { ...targets.carbohydrateGrams, maximum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>脂肪下限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fatGrams.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fatGrams: { ...targets.fatGrams, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>脂肪上限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fatGrams.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fatGrams: { ...targets.fatGrams, maximum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>纤维下限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fiberGrams.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fiberGrams: { ...targets.fiberGrams, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>纤维上限（g）</span><input type="number" min="0" max="1000" value={manualDraft.days[selectedDay]!.nutritionTargets!.fiberGrams.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, fiberGrams: { ...targets.fiberGrams, maximum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>饮水下限（L）</span><input type="number" min="0" max="10" step="0.1" value={manualDraft.days[selectedDay]!.nutritionTargets!.hydrationLiters.minimum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, hydrationLiters: { ...targets.hydrationLiters, minimum: manualNumber(event.target.value) } }))} required /></label>
              <label><span>饮水上限（L）</span><input type="number" min="0" max="10" step="0.1" value={manualDraft.days[selectedDay]!.nutritionTargets!.hydrationLiters.maximum} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, hydrationLiters: { ...targets.hydrationLiters, maximum: manualNumber(event.target.value) } }))} required /></label>
              <div className="health-manual-macros wide"><span>三大营养素比例（合计约 100%）</span><label><b>蛋白</b><input aria-label="蛋白质比例" type="number" min="0" max="100" value={manualDraft.days[selectedDay]!.nutritionTargets!.macroRatioPercent.protein} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, macroRatioPercent: { ...targets.macroRatioPercent, protein: manualNumber(event.target.value) } }))} required /></label><label><b>碳水</b><input aria-label="碳水比例" type="number" min="0" max="100" value={manualDraft.days[selectedDay]!.nutritionTargets!.macroRatioPercent.carbohydrate} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, macroRatioPercent: { ...targets.macroRatioPercent, carbohydrate: manualNumber(event.target.value) } }))} required /></label><label><b>脂肪</b><input aria-label="脂肪比例" type="number" min="0" max="100" value={manualDraft.days[selectedDay]!.nutritionTargets!.macroRatioPercent.fat} onChange={(event) => updateManualNutritionTargets((targets) => ({ ...targets, macroRatioPercent: { ...targets.macroRatioPercent, fat: manualNumber(event.target.value) } }))} required /></label></div>
            </div>}
          </fieldset>
          <label className="wide"><span>饮水参考建议（每行一条，可选）</span><textarea value={manualDraft.days[selectedDay]!.hydrationGuidance?.join("\n") ?? ""} onChange={(event) => updateManualDay({ hydrationGuidance: event.target.value.trim() ? draftLines(event.target.value) : undefined })} rows={3} maxLength={1000} /></label>
          <fieldset className="health-manual-fieldset wide">
            <legend>今日吃法与替代参考（可选）</legend>
            <label className="health-checkbox health-manual-toggle"><input type="checkbox" checked={Boolean(manualDraft.days[selectedDay]!.mealExamples)} onChange={(event) => updateManualDay({ mealExamples: event.target.checked ? { breakfast: [""], lunch: [""], dinner: [""], snack: [] } : undefined })} /><span>填写早餐、午餐、晚餐和可选加餐示例</span></label>
            {manualDraft.days[selectedDay]!.mealExamples && <div className="health-manual-grid">
              <label><span>早餐示例（每行一项）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.breakfast.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, breakfast: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>午餐示例（每行一项）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.lunch.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, lunch: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>晚餐示例（每行一项）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.dinner.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, dinner: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>加餐示例（可留空）</span><textarea value={manualDraft.days[selectedDay]!.mealExamples!.snack.join("\n")} onChange={(event) => updateManualDay({ mealExamples: { ...manualDraft.days[selectedDay]!.mealExamples!, snack: draftLines(event.target.value) } })} rows={3} /></label>
            </div>}
            <label><span>当天蛋白轮换来源（逗号或换行分隔）</span><textarea value={manualDraft.days[selectedDay]!.proteinRotationSources?.join("，") ?? ""} onChange={(event) => updateManualDay({ proteinRotationSources: event.target.value.trim() ? draftLines(event.target.value.replace(/[，,]/g, "\n")) : undefined })} rows={2} /></label>
            <label className="health-checkbox health-manual-toggle"><input type="checkbox" checked={Boolean(manualDraft.days[selectedDay]!.foodReference)} onChange={(event) => updateManualDay({ foodReference: event.target.checked ? { proteinOptions: [""], fiberOptions: [""], carbOptions: [""], fatOptions: [""] } : undefined })} /><span>填写营养目标的食物换算</span></label>
            {manualDraft.days[selectedDay]!.foodReference && <div className="health-manual-grid health-manual-grid-three">
              <label><span>蛋白来源</span><textarea value={manualDraft.days[selectedDay]!.foodReference!.proteinOptions.join("\n")} onChange={(event) => updateManualDay({ foodReference: { ...manualDraft.days[selectedDay]!.foodReference!, proteinOptions: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>纤维来源</span><textarea value={manualDraft.days[selectedDay]!.foodReference!.fiberOptions.join("\n")} onChange={(event) => updateManualDay({ foodReference: { ...manualDraft.days[selectedDay]!.foodReference!, fiberOptions: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>碳水来源</span><textarea value={manualDraft.days[selectedDay]!.foodReference!.carbOptions.join("\n")} onChange={(event) => updateManualDay({ foodReference: { ...manualDraft.days[selectedDay]!.foodReference!, carbOptions: draftLines(event.target.value) } })} rows={3} required /></label>
              <label><span>脂肪来源</span><textarea value={manualDraft.days[selectedDay]!.foodReference!.fatOptions?.join("\n") ?? ""} onChange={(event) => updateManualDay({ foodReference: { ...manualDraft.days[selectedDay]!.foodReference!, fatOptions: draftLines(event.target.value) } })} rows={3} /></label>
            </div>}
          <label className="wide"><span>水果推荐（每行一种，并写明份量，可选）</span><textarea value={manualDraft.days[selectedDay]!.fruitOptions?.join("\n") ?? ""} onChange={(event) => updateManualDay({ fruitOptions: draftLines(event.target.value) })} rows={3} /></label>
          </fieldset>
          <label className="wide"><span>餐盘提示（逗号或换行分隔）</span><textarea value={manualDraft.days[selectedDay]!.plateGuidance.join("\n")} onChange={(event) => updateManualDay({ plateGuidance: listText(event.target.value) })} rows={2} required /></label>
          <label className="wide"><span>时令蔬菜提示（逗号或换行分隔）</span><textarea value={manualDraft.days[selectedDay]!.seasonalVegetables.join("，")} onChange={(event) => updateManualDay({ seasonalVegetables: listText(event.target.value) })} rows={2} required /></label>
          <label className="wide"><span>时令生活提示（可选）</span><textarea value={manualDraft.days[selectedDay]!.seasonalGuidance ?? ""} onChange={(event) => updateManualDay({ seasonalGuidance: event.target.value.trim() ? event.target.value : null })} rows={2} maxLength={500} /></label>
          <label><span>诗词篇名（可选）</span><input value={manualDraft.days[selectedDay]!.seasonalPoem?.title ?? ""} onChange={(event) => updateManualPoem({ title: event.target.value })} maxLength={120} required={Boolean(manualDraft.days[selectedDay]!.seasonalPoem)} /></label>
          <label><span>作者（可选）</span><input value={manualDraft.days[selectedDay]!.seasonalPoem?.author ?? ""} onChange={(event) => updateManualPoem({ author: event.target.value })} maxLength={120} required={Boolean(manualDraft.days[selectedDay]!.seasonalPoem)} /></label>
          <label className="wide"><span>诗句（可选；留空则不显示诗词）</span><textarea value={manualDraft.days[selectedDay]!.seasonalPoem?.excerpt ?? ""} onChange={(event) => event.target.value.trim() ? updateManualPoem({ excerpt: event.target.value }) : updateManualDay({ seasonalPoem: null })} rows={2} maxLength={180} /></label>
          {manualDraft.days[selectedDay]!.seasonalPoem && <label className="wide"><span>与当天的关联</span><textarea value={manualDraft.days[selectedDay]!.seasonalPoem?.relevance ?? ""} onChange={(event) => updateManualPoem({ relevance: event.target.value })} rows={2} maxLength={300} required /></label>}
        </section>}
        <footer><button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Check />}保存为待确认候选</button></footer>
      </form>}
      {visiblePlan ? <section className="health-plan" ref={candidateSectionRef}>
        <header className="health-plan-header"><div><p className="section-kicker">{candidate ? "待确认版本" : "本周生效版本"}</p><h2>{visiblePlan.solarTerm} · {visiblePlan.city ?? "未设置城市"}</h2></div>{candidate && <div className="candidate-actions"><button className="quiet-button" type="button" disabled={busy} onClick={() => void discardCandidate()}>放弃候选</button><button className="primary-button" type="button" disabled={busy} onClick={() => void confirmCandidate()}>{busy ? <LoaderCircle className="spin" /> : <Check />}确认并使用</button></div>}</header>
        <section className="health-week-summary" aria-label="本周摘要">
          <div><p className="section-kicker">本周摘要</p><strong>{profile?.profile.goals.slice(0,3).join("、") || "按已保存资料生成的本周参考"}</strong><p>{visiblePlan.overview}</p></div>
          <dl>
            <div><dt>每周运动</dt><dd>{profile ? `${profile.profile.activity.sessionsPerWeek} 次` : "未提供"}</dd></div>
            <div><dt>单次时长</dt><dd>{profile ? `${profile.profile.activity.usualDurationMinutes.minimum}–${profile.profile.activity.usualDurationMinutes.maximum}m` : "未提供"}</dd></div>
            <div><dt>每日蛋白</dt><dd>{selectedReference ? `${selectedReference.content.proteinRangeGrams.minimum}–${selectedReference.content.proteinRangeGrams.maximum}g` : "未提供"}</dd></div>
            <div><dt>每日饮水</dt><dd>{selectedReference?.content.nutritionTargets ? `${selectedReference.content.nutritionTargets.hydrationLiters.minimum}–${selectedReference.content.nutritionTargets.hydrationLiters.maximum}L` : "当前参考未提供"}</dd></div>
          </dl>
        </section>
        {candidate?.revisionReason && active && candidate.basedOnPlanId === active.id && <section className="health-revision-preview" aria-label="候选前后差异">
          <header><Sparkles /><div><p className="section-kicker">候选说明</p><strong>候选尚未生效</strong></div></header>
          <p>{candidate.revisionReason}</p>
          <div className="health-revision-diff">{planRevisionChanges(active, candidate).map((change) => <div key={change}><strong>本周</strong><span>{change}</span></div>)}{candidate.days.map((day) => {
            const previous = active.days.find((item) => item.dayIndex === day.dayIndex);
            const changes = previous ? revisionChanges(previous, day) : [];
            return changes.length > 0 ? <div key={day.id}><strong>{weekday[day.dayIndex]}</strong><span>{changes.join("；")}</span></div> : null;
          })}{planRevisionChanges(active, candidate).length === 0 && candidate.days.every((day) => {
            const previous = active.days.find((item) => item.dayIndex === day.dayIndex);
            return !previous || revisionChanges(previous, day).length === 0;
          }) && <div><strong>本周</strong><span>候选没有改变当前可显示的每日参考；确认前原计划仍保持不变。</span></div>}</div>
        </section>}
        <div className="health-days" role="tablist" aria-label="本周健康参考日期">{visiblePlan.days.map((day) => <button key={day.id} role="tab" aria-selected={selectedDay === day.dayIndex} className={selectedDay === day.dayIndex ? "active" : ""} type="button" onClick={() => setSelectedDay(day.dayIndex)}><span>{weekday[day.dayIndex]}</span><strong>{day.localDate.slice(8)}</strong></button>)}</div>
        {selectedReference && <>
          {(selectedReference.content.seasonalGuidance||selectedReference.content.seasonalPoem)&&<article className="health-seasonal-card"><Leaf/><div>{selectedReference.content.seasonalGuidance&&<><p className="section-kicker">结合时令与已取得的环境信息</p><strong>{selectedReference.content.seasonalGuidance}</strong></>}{selectedReference.content.seasonalPoem&&<blockquote><Quote/><p>“{selectedReference.content.seasonalPoem.excerpt}”</p><cite>{selectedReference.content.seasonalPoem.author}《{selectedReference.content.seasonalPoem.title}》</cite><small>{selectedReference.content.seasonalPoem.relevance}</small></blockquote>}</div></article>}
          <article className="health-day-detail health-prescription">
            <section className="health-food-prescription">
              <header><Leaf /><div><p>今日饮食</p><strong>今天可以怎样吃</strong></div></header>
              <p>{selectedReference.content.nutritionDirection}</p>
              <div className="health-target-scales">
                {referenceScale("蛋白质", selectedReference.content.proteinRangeGrams, "protein", concreteFoodReference("protein", selectedReference.content.proteinRangeGrams, selectedReference.content.foodReference?.proteinOptions))}
                {referenceScale("碳水", selectedReference.content.nutritionTargets?.carbohydrateGrams, "carb", concreteFoodReference("carb", selectedReference.content.nutritionTargets?.carbohydrateGrams, selectedReference.content.foodReference?.carbOptions))}
                {referenceScale("脂肪", selectedReference.content.nutritionTargets?.fatGrams, "fat", concreteFoodReference("fat", selectedReference.content.nutritionTargets?.fatGrams, selectedReference.content.foodReference?.fatOptions))}
                {referenceScale("膳食纤维", selectedReference.content.nutritionTargets?.fiberGrams, "fiber", concreteFoodReference("fiber", selectedReference.content.nutritionTargets?.fiberGrams, selectedReference.content.foodReference?.fiberOptions))}
                {referenceScale("饮水", selectedReference.content.nutritionTargets?.hydrationLiters, "water", concreteFoodReference("water", selectedReference.content.nutritionTargets?.hydrationLiters, selectedReference.content.hydrationGuidance), "L")}
              </div>
              {selectedReference.content.nutritionTargets ? <div className="health-macro-ratio" aria-label="三大营养素参考比例">
                <header><h3>三大营养素比例</h3><small>只表示建议结构，不代表今日实际摄入</small></header>
                <div aria-hidden="true"><i data-tone="protein" style={{ "--macro-share": `${selectedReference.content.nutritionTargets.macroRatioPercent.protein}%` } as CSSProperties} /><i data-tone="carb" style={{ "--macro-share": `${selectedReference.content.nutritionTargets.macroRatioPercent.carbohydrate}%` } as CSSProperties} /><i data-tone="fat" style={{ "--macro-share": `${selectedReference.content.nutritionTargets.macroRatioPercent.fat}%` } as CSSProperties} /></div>
                <p><span><b data-tone="protein" />蛋白 {selectedReference.content.nutritionTargets.macroRatioPercent.protein}%</span><span><b data-tone="carb" />碳水 {selectedReference.content.nutritionTargets.macroRatioPercent.carbohydrate}%</span><span><b data-tone="fat" />脂肪 {selectedReference.content.nutritionTargets.macroRatioPercent.fat}%</span></p>
              </div> : null}
              <section className="health-hydration-guidance"><h3>今日饮水参考</h3>{listOrMissing(selectedReference.content.hydrationGuidance)}</section>
              <section className="health-protein-rotation"><h3>本周蛋白轮换</h3><div>{visiblePlan.days.map((day)=><span key={day.id} className={day.id===selectedReference.id?"current":""}><b>{weekday[day.dayIndex]}</b><small>{day.content.proteinRotationSources?.join(" / ") || "未提供"}</small></span>)}</div></section>
            </section>
            <section className="health-side-column">
              <section className="health-fruit-reference"><h3>水果推荐</h3>{listOrMissing(selectedReference.content.fruitOptions)}</section>
              <section className="health-supplements"><p className="section-kicker">补充剂建议</p>{visiblePlan.supplements.map((item) => <p key={item}>{item}</p>)}</section>
            </section>
            <section className="health-meal-sheet health-meal-sheet-bottom"><h3>正餐推荐</h3>{selectedReference.content.mealExamples ? <dl>{([['早餐',selectedReference.content.mealExamples.breakfast],['午餐',selectedReference.content.mealExamples.lunch],['晚餐',selectedReference.content.mealExamples.dinner],['加餐',selectedReference.content.mealExamples.snack]] as Array<[string,string[]]>).map(([label,items])=><div key={label}><dt>{label}</dt><dd>{items.length ? items.join(" · ") : "可不安排"}</dd></div>)}</dl> : <p className="health-field-missing">当前参考未提供正餐示例；重新生成候选后可补齐。</p>}</section>
          </article>
        </>}
      </section> : <div className="health-empty"><HeartPulse /><strong>还没有本周参考。按上面三步，用网页版 AI 生成一份，确认后就会显示在这里。</strong></div>}
    </>}
  </section>;
}
