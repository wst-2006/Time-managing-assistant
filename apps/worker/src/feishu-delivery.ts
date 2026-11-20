import { createHash } from "node:crypto";
import type { ReminderDeliveryContext, ReminderDeliveryProvider, ReminderDeliveryResult, ReminderJob } from "./worker-core.js";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  targetOpenId: string;
  taskUrlBase?: string;
};

type TokenState = { token: string; expiresAt: number };

export class FeishuDeliveryProvider implements ReminderDeliveryProvider {
  private tokenState: TokenState | null = null;

  constructor(private readonly config: FeishuConfig, private readonly fetcher: typeof fetch = fetch) {}

  async deliver(job: ReminderJob, context: ReminderDeliveryContext): Promise<ReminderDeliveryResult> {
    const payload = parsePayload(job.payload, job.kind);
    const token = await this.tenantAccessToken();
    const mustReplaceOriginal = job.kind === "task_start_lapsed" || job.kind === "task_start_expire";
    if (mustReplaceOriginal && !context.remoteMessageId) throw new Error("feishu_original_reminder_missing");
    const updating = mustReplaceOriginal || (job.kind === "task_start_ready" && Boolean(context.remoteMessageId));
    const response = await this.fetcher(updating
      ? `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(context.remoteMessageId!)}`
      : "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: updating ? "PATCH" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(updating ? {
        msg_type: "interactive",
        content: JSON.stringify(buildReminderCard(payload, context))
      } : {
        receive_id: this.config.targetOpenId,
        msg_type: "interactive",
        content: JSON.stringify(buildReminderCard(payload, context))
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json().catch(() => ({})) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (!response.ok || result.code !== 0) throw new Error(`feishu_message_failed:${result.code ?? response.status}:${result.msg ?? "unknown"}`);
    return { remoteMessageId: result.data?.message_id ?? context.remoteMessageId };
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 60_000) return this.tokenState.token;
    const response = await this.fetcher("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json().catch(() => ({})) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
      throw new Error(`feishu_token_failed:${result.code ?? response.status}:${result.msg ?? "unknown"}`);
    }
    this.tokenState = { token: result.tenant_access_token, expiresAt: Date.now() + Math.max(60, result.expire ?? 7200) * 1000 };
    return this.tokenState.token;
  }
}

export function loadFeishuConfig(env: NodeJS.ProcessEnv): FeishuConfig | null {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  if (!appId || !appSecret || !targetOpenId) return null;
  return { appId, appSecret, targetOpenId, taskUrlBase: env.APP_PUBLIC_URL?.trim() || undefined };
}

type ReminderCardState = "upcoming" | "ready" | "late" | "started" | "stopped_for_change" | "returned_to_unscheduled" | "cancelled" | "missed";

function parsePayload(value: unknown, kind: string): { taskId: string; title: string; startAt: string; endAt: string; timeZone: string; scheduleRevision: number; cardState: ReminderCardState } {
  if (!value || typeof value !== "object") throw new Error("invalid_reminder_payload");
  const payload = value as Record<string, unknown>;
  if (typeof payload.taskId !== "string" || typeof payload.title !== "string" || typeof payload.startAt !== "string"
    || typeof payload.endAt !== "string" || typeof payload.timeZone !== "string" || typeof payload.scheduleRevision !== "number") {
    throw new Error("invalid_reminder_payload");
  }
  const fallbackState = kind === "task_start"
    ? "upcoming"
    : kind === "task_start_ready"
      ? "ready"
      : kind === "task_start_lapsed"
        ? "late"
        : kind === "task_start_expire"
          ? "missed"
          : null;
  const cardState = payload.cardState ?? fallbackState;
  if (!isReminderCardState(cardState)) throw new Error("invalid_reminder_payload");
  return { ...payload, cardState } as ReturnType<typeof parsePayload>;
}

function isReminderCardState(value: unknown): value is ReminderCardState {
  return value === "upcoming" || value === "ready" || value === "late" || value === "started" || value === "stopped_for_change"
    || value === "returned_to_unscheduled" || value === "cancelled" || value === "missed";
}

function buildReminderCard(payload: ReturnType<typeof parsePayload>, _context: ReminderDeliveryContext) {
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: payload.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(payload.startAt));
  const schedule = taskScheduleText(payload);
  if (payload.cardState === "started") {
    return {
      config: { wide_screen_mode: true },
      header: { template: "green", title: { tag: "plain_text", content: "任务已经开始" } },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: `**${payload.title}**\n${schedule}\n已在桌面软件或飞书完成一次开始确认；原卡片按钮已经失效。` } }
      ]
    };
  }
  if (payload.cardState === "stopped_for_change") {
    return statusCard("本次专注已停止", payload, "原排期保持不变；如需调整，请在桌面软件中明确确认新的安排。", "grey");
  }
  if (payload.cardState === "returned_to_unscheduled") {
    return statusCard("已退回未排期任务", payload, "原时间已释放；需要时可重新拖入时间轴安排。", "grey");
  }
  if (payload.cardState === "cancelled") {
    return statusCard("任务已取消", payload, "任务已移入回收站，不会再启动或发送后续提醒。", "red");
  }
  if (payload.cardState === "missed") {
    return statusCard("任务已过时", payload, "固定时段内没有确认开始；之后的结果补录不会改变这张提醒卡。", "grey");
  }
  const stage = payload.cardState;
  const sharedActions: Array<Record<string, unknown>> = [
    { tag: "button", text: { tag: "plain_text", content: "另有安排" }, value: { action: "other_arrangement", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision, commandId: commandId(payload, "other_arrangement") } },
    { tag: "button", text: { tag: "plain_text", content: "取消任务" }, type: "danger", value: { action: "cancel_request", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision, commandId: commandId(payload, "cancel_request") } }
  ];
  const actions = stage === "ready"
    ? [
        { tag: "button", text: { tag: "plain_text", content: "我会准时开始" }, type: "primary", value: { action: "start", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision, commandId: commandId(payload, "start") } },
        ...sharedActions
      ]
    : stage === "late"
      ? [
          { tag: "button", text: { tag: "plain_text", content: "准时确认已失效" }, disabled: true },
          ...sharedActions
        ]
      : stage === "upcoming" ? sharedActions : [];
  const copy = stage === "late"
      ? `**${payload.title}**\n${schedule}\n开始按钮已经过期。若仍在原任务时段内，请直接告诉 AI“我开始了这个任务”，系统只从实际开始时刻记录。`
      : stage === "ready"
        ? `**${payload.title}**\n${schedule}\n还有 1 分钟开始。点击“我会准时开始”后，到原定时间自动进入专注计时。`
        : `**${payload.title}**\n${schedule}\n开始按钮会在前 1 分钟出现在这张卡片上。`;
  return {
    config: { wide_screen_mode: true },
    header: { template: stage === "late" ? "grey" : stage === "ready" ? "orange" : "green", title: { tag: "plain_text", content: `${time} · ${stage === "late" ? "等待迟到开始" : stage === "ready" ? "准备开始" : "即将开始"}` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: copy } },
      ...(actions.length > 0 ? [{ tag: "action", actions }] : [])
    ]
  };
}

function statusCard(
  heading: string,
  payload: ReturnType<typeof parsePayload>,
  detail: string,
  template: "green" | "grey" | "red"
) {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: heading } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${payload.title}**\n${taskScheduleText(payload)}\n${detail}` } }
    ]
  };
}

function taskScheduleText(payload: { startAt: string; endAt: string; timeZone: string }): string {
  const dateParts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: payload.timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(new Date(payload.startAt));
  const date = `${dateParts.find((part) => part.type === "year")?.value ?? ""}年${dateParts.find((part) => part.type === "month")?.value ?? ""}月${dateParts.find((part) => part.type === "day")?.value ?? ""}日`;
  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: payload.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return `日期：${date}\n开始：${timeFormatter.format(new Date(payload.startAt))}\n结束：${timeFormatter.format(new Date(payload.endAt))}`;
}

function commandId(payload: ReturnType<typeof parsePayload>, action: "start" | "other_arrangement" | "cancel_request"): string {
  const bytes = createHash("sha256")
    .update(`${payload.taskId}:${payload.scheduleRevision}:${action}`)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
