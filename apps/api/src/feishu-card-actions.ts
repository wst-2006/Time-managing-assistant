import { createHash } from "node:crypto";
import { z } from "zod";
import type { FocusService } from "./focus-service.js";
import type { TaskService } from "./task-service.js";

export type FeishuCardActionConfig = { targetOpenId: string };
export type FeishuCardActionResult = {
  type: "success" | "error";
  message: string;
  terminal?: boolean;
  card?: object;
  relatedCardUpdates?: Array<{ messageId: string; card: object }>;
};

const reminderActionSchema = z.object({
  action: z.enum(["start", "other_arrangement", "cancel_request", "cancel_confirm", "cancel_keep"]),
  taskId: z.string().uuid(),
  scheduleRevision: z.number().int().positive(),
  commandId: z.string().uuid().optional()
}).passthrough();

export class FeishuActionAuthError extends Error {}
export class FeishuActionPayloadError extends Error {}

export class FeishuCardActionService {
  constructor(
    private readonly config: FeishuCardActionConfig,
    private readonly taskService: TaskService,
    private readonly focusService: FocusService
  ) {}

  async handle(operatorOpenId: string | undefined, value: unknown): Promise<FeishuCardActionResult> {
    if (operatorOpenId !== this.config.targetOpenId) {
      throw new FeishuActionAuthError("card operator does not match the configured single user");
    }
    const action = reminderActionSchema.safeParse(value);
    if (!action.success) throw new FeishuActionPayloadError("invalid card action payload");

    try {
      const detail = await this.taskService.get(action.data.taskId, true);
      if (detail.task.scheduleRevision !== action.data.scheduleRevision) {
        return this.currentCardForChangedTask(detail.task);
      }
      const focus = await this.focusService.currentForTask(detail.task.id);
      if (focus?.state === "stopped_for_change") {
        return {
          type: "success",
          message: "本次专注已停止，原排期保留；当前卡片操作已失效。",
          terminal: true,
          card: statusCard("本次专注已停止", detail.task, "原排期保持不变；如需调整，请在桌面软件中查看并明确确认新的安排。", "grey")
        };
      }
      // The card's start action is only valid during the preparation window.
      // After the fixed start time it must expire; the text command remains the
      // explicit late-start entry point.
      if (
        action.data.action === "start"
        && detail.task.startAt
        && detail.task.startAt <= new Date()
        && focus?.state !== "running"
      ) {
        return {
          type: "error",
          message: "倒计时已结束；卡片按钮已失效。请在软件中选择“现在开始计时”，或发送“我开始了这个任务”。",
          terminal: true,
          card: statusCard("准时确认已失效", detail.task, "如仍在原定时段内，请明确选择现在开始计时；系统只记录实际开始后的专注。", "grey")
        };
      }
      if (focus && ["armed", "running"].includes(focus.state)) {
        if (action.data.action === "start") return startedResult(detail.task, focus.state);
        return {
          type: "success",
          message: "任务已经开始，当前卡片操作已失效。",
          card: statusCard("任务已经开始", detail.task, "任务已进入固定时段，不能取消、改期或重复操作。", "green")
        };
      }
      if (action.data.action === "cancel_request") {
        if (detail.task.lifecycleStatus !== "open") {
          return { type: "error", message: "任务已经开始或结束，当前不能取消。" };
        }
        return {
          type: "success",
          message: "请再次确认是否取消任务。",
          card: cancelConfirmationCard(detail.task)
        };
      }
      if (action.data.action === "cancel_keep") {
      return {
        type: "success",
        message: "已保留任务，原计划不变。",
        card: reminderControlsCard(detail.task)
        };
      }
      if (action.data.action === "cancel_confirm") {
        if (focus && preparationDecisionStates.has(focus.state)) {
          await this.resolvePreparationDecisionWithRefresh(
            detail.task.id,
            focus,
            "cancel_task",
            "飞书二次确认取消任务",
            action.data.commandId ?? taskActionCommandId(detail.task, "cancel_confirm"),
          );
        } else {
          await this.taskService.cancelAndTrash(detail.task.id, detail.task.version, "飞书二次确认取消任务");
        }
        return {
          type: "success",
          message: "任务已取消并移入回收站。",
          card: statusCard("任务已取消", detail.task, "不会再启动或发送后续提醒；如需恢复，请在软件回收站操作。", "red")
        };
      }
      if (action.data.action === "start") {
        let session = await this.focusService.create(detail.task.id, detail.task.version, "prepare", action.data.commandId);
        if (["scheduled", "preparing", "reminded"].includes(session.state)) {
          session = await this.focusService.begin(
            session.id,
            session.version,
            action.data.commandId ? deriveCommandId(action.data.commandId, "begin") : undefined,
          );
        }
        return startedResult(detail.task, session.state);
      }
      if (focus && preparationDecisionStates.has(focus.state)) {
        await this.resolvePreparationDecisionWithRefresh(
          detail.task.id,
          focus,
          "other_arrangement",
          "飞书选择另有安排",
          action.data.commandId ? deriveCommandId(action.data.commandId, "respond") : undefined
        );
        return {
          type: "success",
          message: "任务已退回未排期列表。",
          card: statusCard("已退回未排期任务", detail.task, "原时间已释放；需要时可重新拖入时间轴安排。", "grey")
        };
      }
      await this.taskService.update(detail.task.id, {
        expectedVersion: detail.task.version,
        expectedScheduleRevision: detail.task.scheduleRevision,
        scheduleKind: "none",
        localDate: detail.task.localDate,
        daypart: null,
        startAt: null,
        endAt: null,
        conflictDecision: "reject",
      });
      return {
        type: "success",
        message: "任务已退回未排期列表。",
        terminal: true,
        card: statusCard("已退回未排期任务", detail.task, "原时间已释放；需要时可重新拖入时间轴安排。", "grey")
      };
    } catch (error) {
      const message = error instanceof Error && error.message.includes("already active")
        ? "当前已有专注会话，请先在软件中处理。"
        : error instanceof Error && error.message.includes("running")
          ? "任务已经开始，当前卡片操作已失效。"
          : "操作未完成，请打开软件查看任务当前状态。";
      return { type: "error", message };
    }
  }

  private async resolvePreparationDecisionWithRefresh(
    taskId: string,
    initial: { id: string; version: number; state: string },
    decision: "other_arrangement" | "cancel_task",
    reason: string,
    commandId?: string,
  ): Promise<void> {
    let current = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!preparationDecisionStates.has(current.state)) {
        throw new Error(`focus session is ${current.state}, not awaiting a preparation decision`);
      }
      try {
        await this.focusService.resolvePreparationDecision(
          current.id,
          current.version,
          decision,
          reason,
          commandId,
        );
        return;
      } catch (error) {
        if (attempt > 0 || !isRefreshableFocusConflict(error)) throw error;
        const refreshed = await this.focusService.currentForTask(taskId);
        if (!refreshed || refreshed.id !== current.id) throw error;
        current = refreshed;
      }
    }
  }

  private async currentCardForChangedTask(task: Awaited<ReturnType<TaskService["get"]>>["task"]): Promise<FeishuCardActionResult> {
    if (task.deletedAt || task.lifecycleStatus === "cancelled") {
      return {
        type: "success",
        message: "任务已取消，当前卡片操作已失效。",
        card: statusCard("任务已取消", task, "不会再启动或发送后续提醒；如需恢复，请在软件回收站操作。", "red")
      };
    }
    if (task.scheduleKind === "none") {
      return {
        type: "success",
        message: "任务已退回未排期列表，当前卡片操作已失效。",
        card: statusCard("已退回未排期任务", task, "原时间已释放；需要时可重新拖入时间轴安排。", "grey")
      };
    }
    if (task.lifecycleStatus === "active" || task.lifecycleStatus === "awaiting_outcome" || await this.focusService.hasStartConfirmation(task.id)) {
      return {
        type: "success",
        message: "任务已经开始，当前卡片操作已失效。",
        card: statusCard("任务已经开始", task, "已完成开始确认；原卡片按钮已经失效。", "green")
      };
    }
    if (task.lifecycleStatus === "closed") {
      return {
        type: "success",
        message: "任务已过时，当前卡片操作已失效。",
        card: statusCard("任务已过时", task, "固定时段内没有确认开始；之后的结果补录不会改变这张提醒卡。", "grey")
      };
    }
    return {
      type: "error",
      message: "任务排期已经变化，当前卡片操作已失效。",
      card: reminderControlsCard(task)
    };
  }
}

const preparationDecisionStates = new Set(["scheduled", "reminded", "preparing", "awaiting_late_start"]);

function isRefreshableFocusConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("version") || message.includes("conflict") || message.includes("changed");
}

function startedResult(task: Awaited<ReturnType<TaskService["get"]>>["task"], state: string): FeishuCardActionResult {
  if (state === "armed") {
    return {
      type: "success",
      message: "任务已经开始；原卡片按钮已失效。",
      card: statusCard("任务已经开始", task, "已确认准时开始，到达原定时间后进入专注计时。", "green")
    };
  }
  if (state === "running") {
    return {
      type: "success",
      message: "任务已经开始，正在从现在计时到原定结束时间。",
      card: statusCard("任务已经开始", task, "正在计时；本次专注从实际开始时间计算，并在原定结束时间停止。", "green")
    };
  }
  return { type: "error", message: "任务当前无法开始，请打开软件查看。", terminal: false };
}

function statusCard(
  heading: string,
  task: Awaited<ReturnType<TaskService["get"]>>["task"],
  detail: string,
  template: "green" | "red" | "grey" | "orange"
) {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: heading } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${task.title}**\n${taskScheduleText(task)}\n${detail}` } }
    ]
  };
}

function deriveCommandId(commandId: string, phase: "respond" | "begin"): string {
  const bytes = createHash("sha256").update(`${commandId}:${phase}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cancelConfirmationCard(task: Awaited<ReturnType<TaskService["get"]>>["task"]) {
  return {
    config: { wide_screen_mode: true },
    header: { template: "red", title: { tag: "plain_text", content: "确认取消任务" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${task.title}**\n${taskScheduleText(task)}\n取消后任务保留在记录中，但不会再启动或提醒。` } },
      { tag: "action", actions: [
        { tag: "button", text: { tag: "plain_text", content: "确认取消" }, type: "danger", value: { action: "cancel_confirm", taskId: task.id, scheduleRevision: task.scheduleRevision, commandId: taskActionCommandId(task, "cancel_confirm") } },
        { tag: "button", text: { tag: "plain_text", content: "保留任务" }, value: { action: "cancel_keep", taskId: task.id, scheduleRevision: task.scheduleRevision } }
      ] }
    ]
  };
}

function taskActionCommandId(
  task: Awaited<ReturnType<TaskService["get"]>>["task"],
  action: "cancel_confirm"
): string {
  const bytes = createHash("sha256").update(`${task.id}:${task.scheduleRevision}:${action}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function reminderControlsCard(task: Awaited<ReturnType<TaskService["get"]>>["task"]) {
  const now = Date.now();
  const startAt = task.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const endAt = task.endAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const actions: Array<Record<string, unknown>> = [];
  if (now >= startAt - 60_000 && now < startAt) {
    actions.push({ tag: "button", text: { tag: "plain_text", content: "我会准时开始" }, type: "primary", value: { action: "start", taskId: task.id, scheduleRevision: task.scheduleRevision } });
  } else if (now >= startAt && now < endAt) {
    actions.push({ tag: "button", text: { tag: "plain_text", content: "准时确认已失效" }, disabled: true });
  }
  actions.push(
    { tag: "button", text: { tag: "plain_text", content: "另有安排" }, value: { action: "other_arrangement", taskId: task.id, scheduleRevision: task.scheduleRevision } },
    { tag: "button", text: { tag: "plain_text", content: "取消任务" }, type: "danger", value: { action: "cancel_request", taskId: task.id, scheduleRevision: task.scheduleRevision } }
  );
  return {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: "任务仍按原计划" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${task.title}**\n${taskScheduleText(task)}\n已撤销取消操作。` } },
      { tag: "action", actions }
    ]
  };
}

function taskScheduleText(task: Awaited<ReturnType<TaskService["get"]>>["task"]): string {
  if (!task.startAt || !task.endAt) return "时间：未设置";
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: task.timeZone ?? "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: task.timeZone ?? "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return `日期：${dateFormatter.format(task.startAt)}\n开始：${timeFormatter.format(task.startAt)}\n结束：${timeFormatter.format(task.endAt)}`;
}

export function loadFeishuCardActionConfig(env: NodeJS.ProcessEnv): FeishuCardActionConfig | null {
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  return targetOpenId ? { targetOpenId } : null;
}
