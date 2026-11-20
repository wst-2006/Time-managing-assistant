import { z } from "zod";
import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

export const briefSectionKeys = ["encouragement"] as const;
export type BriefSectionKey = (typeof briefSectionKeys)[number];

export type BriefWriterInput = {
  localDate: string;
  titleHint: string;
  reflection: string;
  taskSummary: string;
};

export type BriefWriterOutput = {
  title: string;
  reflection: string;
  taskSummary: string;
  sections: Array<{ key: BriefSectionKey; body: string }>;
};

const overviewSchema = z.object({
  title: z.string().trim().min(1).max(200),
  reflection: z.string().trim().min(1).max(8000),
  taskSummary: z.string().trim().min(1).max(4000),
  encouragement: z.string().trim().min(1).max(1000)
}).strict();

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };

class BriefProviderError extends Error {
  constructor(readonly status: number) {
    super(`DeepSeek returned HTTP ${status}.`);
  }
}

class BriefMalformedOutputError extends Error {}

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function isRetryable(error: unknown) {
  if (error instanceof BriefProviderError) return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof BriefMalformedOutputError) return true;
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function parseContent<T>(content: string | Array<{ text?: string }>, schema: z.ZodType<T>) {
  const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content;
  const normalized = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  try {
    return schema.parse(JSON.parse(normalized));
  } catch {
    throw new BriefMalformedOutputError("DeepSeek returned malformed daily brief content.");
  }
}

export interface BriefWriter {
  write(input: BriefWriterInput): Promise<BriefWriterOutput>;
}

export class DeepSeekBriefWriter implements BriefWriter {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async write(input: BriefWriterInput): Promise<BriefWriterOutput> {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const overviewPromise = this.requestJson(overviewSchema, [
      {
        role: "system",
        content: [
          "你是个人学习陪伴软件中的每日简报编辑器。当前请求已经由用户明确触发；你只编辑简报，不创建、修改、移动、取消或关闭任务，也不自动生成赛博日记。",
          "只根据用户复盘与任务摘要编辑个人部分，不推断人格、精神状态或软件外行为。输出简洁，不复制长原文。",
          "输出 JSON 对象：{\"title\":string,\"reflection\":string,\"taskSummary\":string,\"encouragement\":string}。encouragement 只写一两句不过度说教的话。",
          `简报日期：${input.localDate}。标题提示：${input.titleHint}。`,
          context
        ].filter(Boolean).join("\n")
      },
      { role: "user", content: JSON.stringify({ reflection: input.reflection.slice(0, 8_000), taskSummary: input.taskSummary.slice(0, 4_000) }) }
    ], Math.min(this.config.DEEPSEEK_MAX_OUTPUT_TOKENS, 700));
    const overview = await overviewPromise;
    return {
      title: overview.title,
      reflection: overview.reflection,
      taskSummary: overview.taskSummary,
      sections: [{ key: "encouragement", body: overview.encouragement }]
    };
  }

  private async requestJson<T>(schema: z.ZodType<T>, messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestOnce(schema, messages, maxTokens);
      } catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES || !isRetryable(error)) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek daily brief generation failed.");
  }

  private async requestOnce<T>(schema: z.ZodType<T>, messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number): Promise<T> {
    const response = await fetch(endpoint(this.config.DEEPSEEK_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        thinking: { type: "disabled" },
        temperature: 0.25,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });
    if (!response.ok) throw new BriefProviderError(response.status);
    const payload = await response.json() as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new BriefMalformedOutputError("DeepSeek returned no daily brief content.");
    return parseContent(content, schema);
  }
}
