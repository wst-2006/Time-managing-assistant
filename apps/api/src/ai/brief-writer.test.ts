import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekBriefWriter } from "./brief-writer.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 0,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 1_200,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 6_000
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekBriefWriter", () => {
  it("creates a local structured brief without task-writing authority", async () => {
    const generated = {
      title: "2026-08-06 的每日简报",
      reflection: "今天完成了复盘，并保留了仍需调整的部分。",
      taskSummary: "当天安排两项任务，完成一项。",
      encouragement: "留下记录，明天就有可继续的起点。"
    };
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(generated) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DeepSeekBriefWriter(config).write({
      localDate: "2026-08-06",
      titleHint: "2026-08-06 的每日简报",
      reflection: "用户复盘",
      taskSummary: "当天任务摘要"
    });

    expect(result.sections).toEqual([{ key: "encouragement", body: generated.encouragement }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const overviewCall = fetchMock.mock.calls[0] as [string, RequestInit];
    const [url, options] = overviewCall;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(options.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content).toContain("不创建、修改、移动、取消或关闭任务");
    expect(body.max_tokens).toBe(700);
  });

  it("rejects incomplete model output instead of persisting a false brief", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: "不完整" }) } }]
    }), { status: 200 })));

    await expect(new DeepSeekBriefWriter(config).write({
      localDate: "2026-08-06",
      titleHint: "每日简报",
      reflection: "复盘",
      taskSummary: "任务"
    })).rejects.toThrow();
  });

  it("retries one malformed structured response before giving up", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "恢复后的简报", reflection: "复盘摘要", taskSummary: "任务摘要", encouragement: "继续。"
      }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DeepSeekBriefWriter({ ...config, DEEPSEEK_MAX_RETRIES: 1 }).write({
      localDate: "2026-08-07",
      titleHint: "每日简报",
      reflection: "复盘",
      taskSummary: "任务"
    });

    expect(result.title).toBe("恢复后的简报");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
