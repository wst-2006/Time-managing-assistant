import { createLarkChannel, type CardActionEvent, type LarkChannel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { FeishuCardActionResult, FeishuCardActionService } from "./feishu-card-actions.js";

export type FeishuLongConnectionConfig = {
  appId: string;
  appSecret: string;
  handshakeTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

type CardActionHandler = (event: { messageId: string; chatId: string; operatorOpenId: string; value: unknown }) => Promise<void>;
type TextMessageHandler = (event: { messageId: string; chatId: string; operatorOpenId: string; text: string; messageType: string }) => Promise<void>;

export interface FeishuChannelClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  forceDisconnect(): Promise<void>;
  updateCard(messageId: string, card: object): Promise<void>;
  sendText(targetId: string, text: string): Promise<void>;
  sendCard(targetId: string, card: object): Promise<void>;
  onCardAction(handler: CardActionHandler): void;
  onMessage(handler: TextMessageHandler): void;
  onError(handler: (error: Error) => void): void;
  onReconnecting(handler: () => void): void;
  onReconnected(handler: () => void): void;
}

export type FeishuChannelFactory = (config: FeishuLongConnectionConfig) => FeishuChannelClient;

export type FeishuConnectionLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export class FeishuLongConnectionService {
  private channel: FeishuChannelClient | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private stopped = true;
  private generation = 0;

  constructor(
    private readonly config: FeishuLongConnectionConfig,
    private readonly actions: FeishuCardActionService,
    private readonly channelFactory: FeishuChannelFactory = createSdkChannel,
    private readonly logger: FeishuConnectionLogger = console
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    await this.connect(this.generation);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const channel = this.channel;
    this.channel = null;
    if (channel) await channel.forceDisconnect();
  }

  private async connect(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    const channel = this.channelFactory(this.config);
    this.channel = channel;
    channel.onCardAction(async (event) => {
      this.logger.info(`Feishu card action received: ${event.value && typeof event.value === "object" && "action" in event.value ? String((event.value as { action?: unknown }).action) : "unknown"}.`);
      try {
        const result = await this.actions.handle(event.operatorOpenId, event.value);
        this.logger.info(`Feishu card action handled: ${result.type}; ${result.message}`);
        let relatedCardUpdateFailed = false;
        if (result.relatedCardUpdates) {
          for (const update of result.relatedCardUpdates) {
            try {
              await channel.updateCard(update.messageId, update.card);
            } catch (updateError) {
              relatedCardUpdateFailed = true;
              this.logger.warn(`Feishu related reminder card update failed: ${errorMessage(updateError)}`);
            }
          }
        }
        if (result.card) {
          try {
            await channel.updateCard(event.messageId, result.card);
          } catch (updateError) {
            this.logger.warn(`Feishu terminal card update failed; sending text fallback: ${errorMessage(updateError)}`);
            await channel.sendText(event.chatId, result.message);
          }
          if (relatedCardUpdateFailed) {
            await channel.sendText(event.chatId, "排期已经保存，但有旧提醒卡片未能刷新；请以软件中的当前排期为准。");
          }
          return;
        }
        if (result.terminal === false) {
          // Navigation is not a terminal decision. Keep the reminder controls
          // available so the user can still choose “开始” or “另有安排”.
          await channel.sendText(event.chatId, result.message);
          return;
        }
        try {
          // Preserve the original message and replace its controls with an
          // immutable terminal state. Feishu recalls always leave a visible
          // "message recalled" trace, which is undesirable for one-shot cards.
          await channel.updateCard(event.messageId, actionResultCard(result));
          return;
        } catch (updateError) {
          this.logger.warn(`Feishu card update failed; sending text fallback: ${errorMessage(updateError)}`);
        }
        await channel.sendText(event.chatId, result.message);
      } catch (error) {
        this.logger.warn(`Feishu card action rejected: ${errorMessage(error)}`);
        const message = "操作未完成，请打开软件查看任务当前状态。";
        try {
          await channel.updateCard(event.messageId, actionResultCard({ type: "error", message }));
        } catch (updateError) {
          this.logger.warn(`Feishu card error update failed; sending text fallback: ${errorMessage(updateError)}`);
          try {
            await channel.sendText(event.chatId, message);
          } catch (fallbackError) {
            this.logger.warn(`Feishu card action fallback failed: ${errorMessage(fallbackError)}`);
          }
        }
      }
    });
    channel.onError((error) => this.logger.error(`Feishu long connection error: ${error.message}`));
    channel.onReconnecting(() => this.logger.warn("Feishu long connection reconnecting."));
    channel.onReconnected(() => this.logger.info("Feishu long connection reconnected."));

    try {
      await channel.connect();
      if (this.stopped || generation !== this.generation) {
        await channel.forceDisconnect();
        return;
      }
      this.retryAttempt = 0;
      this.logger.info("Feishu long connection established.");
    } catch (error) {
      await channel.forceDisconnect().catch(() => undefined);
      if (this.channel === channel) this.channel = null;
      if (this.stopped || generation !== this.generation) return;
      this.logger.error(`Feishu long connection failed: ${errorMessage(error)}`);
      this.scheduleRetry(generation);
    }
  }

  private scheduleRetry(generation: number): void {
    const delay = Math.min(this.config.retryBaseMs * 2 ** this.retryAttempt, this.config.retryMaxMs);
    this.retryAttempt += 1;
    this.logger.warn(`Feishu long connection will retry in ${delay}ms.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(generation);
    }, delay);
    this.retryTimer.unref?.();
  }
}

export function loadFeishuLongConnectionConfig(env: NodeJS.ProcessEnv): FeishuLongConnectionConfig | null {
  const transport = env.FEISHU_CALLBACK_TRANSPORT?.trim().toLowerCase() || "websocket";
  if (transport === "http") return null;
  if (transport !== "websocket") throw new Error("FEISHU_CALLBACK_TRANSPORT must be websocket or http");
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  if (!appId || !appSecret || !targetOpenId) return null;
  return {
    appId,
    appSecret,
    handshakeTimeoutMs: positiveInteger(env.FEISHU_WS_HANDSHAKE_TIMEOUT_MS, 15_000),
    retryBaseMs: positiveInteger(env.FEISHU_WS_RETRY_BASE_MS, 5_000),
    retryMaxMs: positiveInteger(env.FEISHU_WS_RETRY_MAX_MS, 60_000)
  };
}

function createSdkChannel(config: FeishuLongConnectionConfig): FeishuChannelClient {
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: "websocket",
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    logger: createRedactedSdkLogger(),
    source: "time-managing-assistant"
  });
  return new SdkFeishuChannel(channel);
}

function createRedactedSdkLogger() {
  return {
    error: (...messages: unknown[]) => console.error(...messages.map((message) => redactLogValue(message))),
    warn: (...messages: unknown[]) => console.warn(...messages.map((message) => redactLogValue(message))),
    info: (...messages: unknown[]) => console.info(...messages.map((message) => redactLogValue(message))),
    debug: (...messages: unknown[]) => console.debug(...messages.map((message) => redactLogValue(message))),
    trace: (...messages: unknown[]) => console.trace(...messages.map((message) => redactLogValue(message))),
  };
}

function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(\"(?:app_secret|app_token|tenant_access_token|authorization)\"\s*:\s*\")[^\"]*(\")/gi, "$1[REDACTED]$2")
      .replace(/(app_secret|app_token|tenant_access_token|authorization)(\s*[=:]\s*)[^,;\s}]+/gi, "$1$2[REDACTED]");
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactLogValue(value.message), stack: value.stack ? redactLogValue(value.stack) : undefined };
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/secret|token|authorization|password/i.test(key)) output[key] = "[REDACTED]";
    else output[key] = redactLogValue(entry, seen);
  }
  return output;
}

export class SdkFeishuChannel implements FeishuChannelClient {
  constructor(private readonly channel: LarkChannel) {}
  connect() { return this.channel.connect(); }
  disconnect() { return this.channel.disconnect(); }
  async forceDisconnect() {
    this.channel.rawWsClient?.close({ force: true });
    await this.channel.disconnect();
  }
  updateCard(messageId: string, card: object) { return this.channel.updateCard(messageId, card); }
  async sendText(targetId: string, text: string) {
    await this.channel.send(targetId, { text });
  }
  async sendCard(targetId: string, card: object) {
    await this.channel.send(targetId, { card });
  }
  onCardAction(handler: CardActionHandler) {
    this.channel.on("cardAction", (event: CardActionEvent) => {
      // The SDK waits for this listener before acknowledging the button click.
      // Detach business processing so Feishu receives its acknowledgement
      // immediately instead of showing error 300000 after a three-second wait.
      void handler({
        messageId: event.messageId,
        chatId: event.chatId,
        operatorOpenId: event.operator.openId,
        value: event.action.value
      }).catch(() => undefined);
    });
  }
  onMessage(handler: TextMessageHandler) {
    this.channel.on("message", (event: NormalizedMessage) => handler({
      messageId: event.messageId,
      chatId: event.chatId,
      operatorOpenId: event.senderId,
      text: event.content,
      messageType: event.rawContentType
    }));
  }
  onError(handler: (error: Error) => void) { this.channel.on("error", handler); }
  onReconnecting(handler: () => void) { this.channel.on("reconnecting", handler); }
  onReconnected(handler: () => void) { this.channel.on("reconnected", handler); }
}

function actionResultCard(result: FeishuCardActionResult) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: result.type === "success" ? "green" : "red",
      title: { tag: "plain_text", content: result.type === "success" ? "操作已处理" : "操作未完成" }
    },
    elements: [{ tag: "div", text: { tag: "lark_md", content: result.message } }]
  };
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Feishu WebSocket timing values must be positive integers");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
