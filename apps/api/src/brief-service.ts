import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { dailyBriefs, reviewMessages, reviewSessions, tasks } from "@personal-ai/db/schema";
import { BriefProviders, type BriefSection, type BriefSource } from "./brief-providers.js";
import type { BriefWriter } from "./ai/brief-writer.js";

type BriefContent = { title:string; reflection:string; taskSummary:string; sections:BriefSection[]; location?: Awaited<ReturnType<BriefProviders["weather"]>>["location"]; weather?: Awaited<ReturnType<BriefProviders["weather"]>>["weather"] };

export class BriefNotFoundError extends Error {}
export class BriefReviewRequiredError extends Error {}
export class BriefGenerationUnavailableError extends Error {}

export class BriefService {
  constructor(
    private readonly db: AppDatabase,
    private readonly providers = new BriefProviders(),
    private readonly writer?: BriefWriter
  ) {}

  async generateFromReview(reviewSessionId: string, locationName?: string) {
    const [review] = await this.db.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
    if (!review) throw new BriefNotFoundError();
    const messages = await this.db.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).orderBy(asc(reviewMessages.createdAt));
    const conversationMessages = messages.filter((message) => message.source === "app" || message.source === "ai");
    if (!conversationMessages.some((message) => message.source === "app")) throw new BriefReviewRequiredError();
    const taskRows = await this.db.select().from(tasks).where(eq(tasks.localDate, review.localDate));
    const formalTaskRows = taskRows.filter((task) => task.recordKind !== "backfill");
    const closed = formalTaskRows.filter((task) => task.lifecycleStatus === "closed").length;
    const { content, sources } = await this.generateContent({
      localDate: review.localDate,
      reflection: conversationMessages.map((message) => `${message.source === "ai" ? "[AI 回应]" : "[用户复盘]"}\n${message.content}`).join("\n\n"),
      taskSummary: `当天共安排 ${formalTaskRows.length} 项正式任务，已关闭 ${closed} 项；补录事实会在复盘材料中单独保留。`,
      locationName,
      sourceLabel: "复盘正文与本项目任务数据"
    });
    return this.db.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.reviewSessionId, review.id)).orderBy(desc(dailyBriefs.updatedAt)).limit(1);
      if (existing) {
        const [updated] = await transaction.update(dailyBriefs).set({ content, sources, state: "draft", updatedAt: new Date() }).where(eq(dailyBriefs.id, existing.id)).returning();
        return updated!;
      }
      return (await transaction.insert(dailyBriefs).values({ id: randomUUID(), localDate: review.localDate, reviewSessionId: review.id, state: "draft", content, sources }).returning())[0]!;
    });
  }

  async generateFromConversation(conversation: string, localDate: string, locationName?: string) {
    const { content, sources } = await this.generateContent({
      localDate,
      reflection: conversation,
      taskSummary: "这是一份由用户明确请求生成的独立简报，不关联今日复盘，也不会生成赛博日记。",
      locationName,
      sourceLabel: "用户明确请求的独立对话内容",
      title: `${localDate} 的独立简报`
    });
    return (await this.db.insert(dailyBriefs).values({ id: randomUUID(), localDate, reviewSessionId: null, state: "confirmed", content, sources }).returning())[0]!;
  }

  async recordLocationWeather(reviewSessionId: string, input: { locationName?: string; latitude?: number; longitude?: number }) {
    const [review] = await this.db.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
    if (!review) throw new BriefNotFoundError();
    const weather = input.latitude !== undefined && input.longitude !== undefined
      ? await this.providers.weatherAtCoordinates(input.latitude, input.longitude)
      : await this.providers.weather(input.locationName);
    const content: BriefContent = { title: "今日地点及天气情况", reflection: "", taskSummary: "", sections: [weather.section], location: weather.location, weather: weather.weather };
    return this.db.transaction(async (transaction) => {
      const rows = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.reviewSessionId, review.id)).orderBy(desc(dailyBriefs.updatedAt));
      const locationRecord = rows.find((row) => (row.content as Partial<BriefContent>).title === "今日地点及天气情况");
      if (locationRecord) {
        const [updated] = await transaction.update(dailyBriefs).set({ content, sources: weather.source ? [weather.source] : [], updatedAt: new Date() }).where(eq(dailyBriefs.id, locationRecord.id)).returning();
        return updated!;
      }
      const [created] = await transaction.insert(dailyBriefs).values({ id: randomUUID(), localDate: review.localDate, reviewSessionId: review.id, state: "draft", content, sources: weather.source ? [weather.source] : [] }).returning();
      return created!;
    });
  }

  async listStandalone(localDate: string) {
    return this.db.select().from(dailyBriefs).where(and(eq(dailyBriefs.localDate, localDate), isNull(dailyBriefs.reviewSessionId))).orderBy(desc(dailyBriefs.updatedAt));
  }

  async importExternal(input: { provider: "work_buddy" | "feishu_manual"; sourceMessageId: string; localDate: string; text: string }) {
    const normalized = input.text.replace(/\r\n?/gu, "\n").trim();
    if (!normalized) throw new BriefGenerationUnavailableError();
    const id = deterministicBriefId(input.provider, input.sourceMessageId);
    const retrievedAt = new Date().toISOString();
    const providerLabel = input.provider === "work_buddy" ? "Work Buddy" : "飞书手动转入";
    const title = externalBriefTitle(normalized, providerLabel, input.localDate);
    const sources: BriefSource[] = [
      { kind: "external_brief", label: `${providerLabel} 简报`, provider: input.provider, retrievedAt },
      ...extractExternalUrls(normalized).map((url, index) => ({
        kind: "external_brief" as const,
        label: `${providerLabel} 原文链接 ${index + 1}`,
        url,
        provider: input.provider,
        retrievedAt
      }))
    ];
    const content: BriefContent = {
      title,
      reflection: boundedText(normalized, 8_000),
      taskSummary: "这是一份从外部简报渠道导入的待确认内容；它不关联今日复盘，也不会解锁或生成赛博日记。",
      sections: [{ title: `${providerLabel} 原文`, body: boundedText(normalized, 4_000) }]
    };
    const [inserted] = await this.db.insert(dailyBriefs).values({
      id,
      localDate: input.localDate,
      reviewSessionId: null,
      state: "draft",
      content,
      sources
    }).onConflictDoNothing().returning();
    if (inserted) return { brief: inserted, created: true };
    const [existing] = await this.db.select().from(dailyBriefs).where(eq(dailyBriefs.id, id)).limit(1);
    if (!existing) throw new BriefGenerationUnavailableError();
    return { brief: existing, created: false };
  }

  private async generateContent(input: { localDate: string; reflection: string; taskSummary: string; locationName?: string; sourceLabel: string; title?: string }) {
    const weather = await this.providers.weather(input.locationName);
    let generated: Awaited<ReturnType<BriefWriter["write"]>> | null = null;
    if (this.writer) {
      try {
        generated = await this.writer.write({
          localDate: input.localDate,
          titleHint: input.title ?? `${input.localDate} 的每日简报`,
          reflection: input.reflection,
          taskSummary: input.taskSummary,
        });
      } catch {
        throw new BriefGenerationUnavailableError();
      }
    }
    const editorialSections: BriefSection[] = generated
      ? generated.sections.map((section) => ({ title: section.key === "encouragement" ? "给今天的一句话" : section.key, body: section.body }))
      : [{ title: "给今天的一句话", body: "今天留下的记录已经足够成为下一步的起点，按自己的节奏继续。" }];
    const content: BriefContent = {
      title: generated?.title ?? input.title ?? `${input.localDate} 的每日简报`,
      reflection: generated?.reflection ?? input.reflection,
      taskSummary: generated?.taskSummary ?? input.taskSummary,
      sections: [...editorialSections, weather.section],
      location: weather.location,
      weather: weather.weather
    };
    const sources: BriefSource[] = [
      { kind: "personal_record", label: input.sourceLabel, provider: "personal_ai", retrievedAt: new Date().toISOString() },
      ...(weather.source ? [weather.source] : [])
    ];
    return { content, sources };
  }

  async update(id: string, content: BriefContent, state?: "draft" | "confirmed") {
    const [updated] = await this.db.update(dailyBriefs).set({ content, ...(state ? { state } : {}), updatedAt: new Date() }).where(eq(dailyBriefs.id, id)).returning();
    if (!updated) throw new BriefNotFoundError();
    return updated;
  }
}

function deterministicBriefId(provider: string, sourceMessageId: string): string {
  const hex = createHash("sha256").update(`${provider}:${sourceMessageId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function externalBriefTitle(text: string, providerLabel: string, localDate: string): string {
  const firstLine = text.split("\n").map((line) => line.replace(/^\s{0,3}#{1,6}\s*/u, "").trim()).find(Boolean);
  const usable = firstLine && firstLine.length <= 100 && !/^https?:\/\//iu.test(firstLine) ? firstLine : null;
  return boundedText(usable ?? `${providerLabel} · ${localDate} 每日简报`, 200);
}

function extractExternalUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()\[\]{}"']+/giu) ?? [];
  const seen = new Set<string>();
  return matches.flatMap((raw) => {
    const candidate = raw.replace(/[，。；：、!?！？.,;:]+$/u, "");
    try {
      const url = new URL(candidate);
      if (!/^https?:$/u.test(url.protocol) || seen.has(url.toString())) return [];
      seen.add(url.toString());
      return [url.toString()];
    } catch {
      return [];
    }
  }).slice(0, 12);
}

function boundedText(value: string, limit: number): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 12)).trimEnd()}\n\n［内容截断］`;
}
