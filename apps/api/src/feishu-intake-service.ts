import type { AppDatabase } from "@personal-ai/db/client";
import { feishuIntakeCandidates, inboxEntries, reminderJobs, tasks } from "@personal-ai/db/schema";
import {
  extractPlanInstruction,
  inferPlanInstructionDate,
  localDateAtTimeZone,
  naturalLanguageTaskCandidateSchema,
  parsePlanShiftOffset,
  type NaturalLanguageTaskCandidate,
  type TaskInput
} from "@personal-ai/domain/task";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskParser } from "./ai/task-parser.js";
import type { FocusService } from "./focus-service.js";
import {
  HealthConversationNoPendingReplyError,
  HealthConversationReplyUnavailableError,
  type HealthConversationResponder,
  type HealthConversationService
} from "./health-conversation-service.js";
import type { BriefService } from "./brief-service.js";
import {
  ConflictSetChangedError,
  BulkShiftValidationError,
  TaskScheduleWindowError,
  TaskTimeConflictError,
  TaskVersionConflictError,
  type BulkShiftAdjustment,
  type TaskService
} from "./task-service.js";

export type FeishuIntakeConfig = { targetOpenId: string; timeZone: "Asia/Shanghai"; workBuddySenderIds?: string[] };
export type FeishuIntakeState = "parsing" | "awaiting_duration" | "pending" | "confirming" | "confirmed" | "cancelled" | "needs_desktop" | "failed";
export type StoredFeishuIntakeCandidate = typeof feishuIntakeCandidates.$inferSelect;

export type FeishuTextMessage = {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  text: string;
  messageType: string;
};

export type FeishuIntakeReply =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "card"; card: object }
  | { kind: "card_update"; messageId: string; card: object; text: string };

export type FeishuIntakeAction = {
  action: "intake_confirm" | "intake_cancel" | "plan_shift_confirm" | "plan_shift_cancel";
  candidateId: string;
  expectedVersion: number;
};

export type FeishuIntakeActionResult = {
  type: "success" | "error";
  message: string;
  terminal?: boolean;
  card?: object;
  relatedCardUpdates?: Array<{ messageId: string; card: object }>;
};
export type FeishuHealthConversationBridge = {
  service: HealthConversationService;
  responder: HealthConversationResponder;
};

const actionSchema = z.object({
  action: z.enum(["intake_confirm", "intake_cancel", "plan_shift_confirm", "plan_shift_cancel"]),
  candidateId: z.string().uuid(),
  expectedVersion: z.number().int().positive()
}).strict();

const planShiftCandidateSchema = z.object({
  kind: z.literal("bulk_shift"),
  localDate: z.string().date(),
  offsetMinutes: z.number().int().refine((value) => value !== 0 && value % 30 === 0 && Math.abs(value) <= 720),
  adjustments: z.array(z.object({
    taskId: z.string().uuid(), title: z.string().min(1),
    expectedVersion: z.number().int().positive(), expectedScheduleRevision: z.number().int().positive(),
    currentStartAt: z.string().datetime(), currentEndAt: z.string().datetime(),
    nextStartAt: z.string().datetime(), nextEndAt: z.string().datetime()
  }).strict()).min(1).max(200)
}).strict();
type PlanShiftCandidate = z.infer<typeof planShiftCandidateSchema>;

export class FeishuIntakeAuthError extends Error {}
export class FeishuIntakePayloadError extends Error {}

export class FeishuIntakeService {
  constructor(
    private readonly config: FeishuIntakeConfig,
    private readonly db: AppDatabase,
    private readonly taskService: TaskService,
    private readonly parser: TaskParser,
    private readonly focusService?: FocusService,
    private readonly healthConversation?: FeishuHealthConversationBridge,
    private readonly briefService?: BriefService
  ) {}

  async receive(message: FeishuTextMessage): Promise<FeishuIntakeReply> {
    const isOwner = message.operatorOpenId === this.config.targetOpenId;
    const isWorkBuddy = Boolean(this.config.workBuddySenderIds?.includes(message.operatorOpenId));
    if (!isOwner && !isWorkBuddy) return { kind: "none" };
    if (message.messageType !== "text" && message.messageType !== "post") {
      return { kind: "text", text: "目前飞书快捷录入只处理文本消息。" };
    }
    const text = message.text.trim();
    if (!text) return { kind: "text", text: "没有读到可整理的文本，请直接发送任务、想法或问题。" };
    const manualBrief = isOwner ? text.match(/^(?:今日|每日)?简报\s*[:：]\s*([\s\S]+)$/u) : null;
    if (isWorkBuddy || manualBrief) {
      if (!this.briefService) return { kind: "text", text: "外部简报导入尚未启用；原始消息没有写入软件。" };
      const imported = await this.briefService.importExternal({
        provider: isWorkBuddy ? "work_buddy" : "feishu_manual",
        sourceMessageId: message.messageId,
        localDate: localDateAtTimeZone(new Date(), this.config.timeZone),
        text: isWorkBuddy ? text : manualBrief?.[1] ?? text
      });
      return imported.created
        ? { kind: "text", text: "每日简报已导入软件并标记为待确认；它不会自动进入复盘或赛博日记。" }
        : { kind: "text", text: "这份每日简报已经导入过，不会重复保存。" };
    }
    if (!isOwner) return { kind: "none" };
    if (await this.hasProcessedMessage(message.messageId)) return { kind: "none" };

    const healthPrefix = text.match(/^健康\s*[:：]\s*(.*)$/su);
    if (healthPrefix) {
      const healthText = healthPrefix[1]?.trim() ?? "";
      if (!healthText) return { kind: "text", text: "请在“健康：”后面写下需要补充的内容。" };
      return this.receiveHealthMessage(message, healthText);
    }

    const planInstruction = extractPlanInstruction(text);
    if (planInstruction !== null) {
      const received = await this.createReceived(message, text);
      if (!received) return { kind: "none" };
      return this.receivePlanShift(received, planInstruction, text);
    }

    if (this.focusService && isFocusStartMessage(text)) {
      const session = await this.focusService.startAwaitingCurrent();
      if (!session) return { kind: "text", text: "当前没有仍处于有效时段、可确认开始的任务。" };
      const messageId = await this.startedReminderMessageId(session.taskId);
      const task = await this.taskService.get(session.taskId);
      const responseText = session.state === "armed"
        ? "任务已经开始准备；我会在原定时间准时开始。"
        : "任务已经开始。系统将从现在起记录实际专注时间，固定截止时间不变。";
      return messageId
        ? { kind: "card_update", messageId, card: startedTaskCard(responseText, session.state, task.task), text: responseText }
        : { kind: "text", text: responseText };
    }

    const awaitingDuration = await this.findAwaitingDuration(message.chatId, message.operatorOpenId);
    if (awaitingDuration) {
      if (awaitingDuration.lastSourceMessageId === message.messageId) return { kind: "none" };
      if (/^(?:取消|算了|不用了|放弃)$/u.test(text)) {
        const cancelled = await this.transition(awaitingDuration.id, awaitingDuration.version, "awaiting_duration", "cancelled", {
          resolvedAt: new Date()
        });
        return cancelled
          ? { kind: "text", text: "已放弃这条排期候选，没有创建任务。" }
          : { kind: "none" };
      }
      return this.completeDurationFollowUp(awaitingDuration, message, text);
    }

    const received = await this.createReceived(message, text);
    if (!received) return { kind: "none" };

    try {
      const candidate = await this.parser.parse({
        text,
        referenceDate: localDateAtTimeZone(new Date(), this.config.timeZone),
        timeZone: this.config.timeZone
      });
      const state = needsDuration(candidate) ? "awaiting_duration" : requiresDesktop(candidate) ? "needs_desktop" : "pending";
      const stored = await this.saveParsed(received.id, candidate, state);
      if (!stored) return { kind: "none" };
      if (state === "awaiting_duration") {
        return { kind: "text", text: "已经记下开始时间。准备做多久？例如：30 分钟、1 小时或 90 分钟。" };
      }
      if (state === "needs_desktop") {
        return { kind: "text", text: "这条内容已整理为待完善候选；请在桌面软件中补全日期或排期后再创建，当前没有自动写入任务。" };
      }
      return { kind: "card", card: candidateCard(stored, candidate) };
    } catch (error) {
      await this.markFailed(received.id, intakeFailureDetail(error));
      return { kind: "text", text: "AI 暂时无法整理这条内容，原始消息没有被写入任务；请稍后重发，或在桌面软件中手动录入。" };
    }
  }

  private async receivePlanShift(
    received: StoredFeishuIntakeCandidate,
    instruction: string,
    rawText: string
  ): Promise<FeishuIntakeReply> {
    const referenceDate = localDateAtTimeZone(new Date(), this.config.timeZone);
    const localDate = inferPlanInstructionDate(rawText, referenceDate);
    const offsetMinutes = parsePlanShiftOffset(instruction);
    if (!instruction || !offsetMinutes) {
      await this.markFailed(received.id, "计划调整缺少明确的顺延时间");
      return { kind: "text", text: "请写清楚移动多久，例如“计划：把今天所有任务顺延 30 分钟”。" };
    }
    if (!localDate) {
      await this.markFailed(received.id, "计划调整缺少明确日期");
      return { kind: "text", text: "请写明作用日期，例如“今天”“明天”或具体日期；飞书不会跨多个日期批量修改任务。" };
    }
    const preview = await this.taskService.previewBulkShift(localDate, offsetMinutes);
    const selected = selectPlanShiftAdjustments(instruction, preview.adjustments, this.config.timeZone);
    if (selected.error || selected.adjustments.length === 0) {
      await this.markFailed(received.id, selected.error ?? "没有可调整的精确排期任务");
      const available = preview.adjustments.slice(0, 6).map((item) => item.title).join("、");
      return { kind: "text", text: selected.error ?? (available
        ? `没有确定要调整哪些任务。当天可调整：${available}。请明确任务名称或说“所有任务”。`
        : "该日期没有尚可调整的精确排期任务。") };
    }
    const candidate: PlanShiftCandidate = { kind: "bulk_shift", localDate, offsetMinutes, adjustments: selected.adjustments };
    const [saved] = await this.db.update(feishuIntakeCandidates).set({
      candidate,
      targetTaskId: selected.adjustments[0]!.taskId,
      state: "pending",
      version: received.version + 1,
      updatedAt: new Date()
    }).where(and(
      eq(feishuIntakeCandidates.id, received.id),
      eq(feishuIntakeCandidates.version, received.version),
      eq(feishuIntakeCandidates.state, "parsing")
    )).returning();
    if (!saved) return { kind: "none" };
    return { kind: "card", card: planShiftPreviewCard(saved, candidate, preview.skipped) };
  }

  private async handlePlanShiftAction(
    current: StoredFeishuIntakeCandidate,
    candidate: PlanShiftCandidate,
    action: FeishuIntakeAction
  ): Promise<FeishuIntakeActionResult> {
    if (current.state === "confirmed") {
      return { type: "success", message: "这组排期已经调整完成。", card: planShiftCompletedCard(candidate) };
    }
    if (current.state === "cancelled") {
      return { type: "success", message: "已放弃这组计划调整，没有修改任务。", card: planShiftCancelledCard(candidate) };
    }
    if (current.state === "confirming") {
      return { type: "success", message: "这组排期正在处理，请稍后查看。", terminal: false };
    }
    if (current.state !== "pending" || current.version !== action.expectedVersion) {
      return { type: "error", message: "预览已经变化，请重新发送计划调整指令。", terminal: false };
    }
    if (action.action === "plan_shift_cancel") {
      const cancelled = await this.transition(current.id, current.version, "pending", "cancelled", { resolvedAt: new Date() });
      return cancelled
        ? { type: "success", message: "已放弃这组计划调整，没有修改任务。", card: planShiftCancelledCard(candidate) }
        : { type: "error", message: "预览状态已变化，请重新发送指令。", terminal: false };
    }
    if (action.action !== "plan_shift_confirm") {
      return { type: "error", message: "这张卡片只能确认或放弃计划调整。", terminal: false };
    }
    const claimed = await this.transition(current.id, current.version, "pending", "confirming", {});
    if (!claimed) return { type: "success", message: "这组排期正在处理，请稍后查看。", terminal: false };

    const taskIds = candidate.adjustments.map((item) => item.taskId);
    const oldCards = await this.db.select({
      taskId: reminderJobs.taskId,
      messageId: reminderJobs.remoteMessageId,
      updatedAt: reminderJobs.updatedAt
    }).from(reminderJobs).where(and(
      inArray(reminderJobs.taskId, taskIds),
      isNotNull(reminderJobs.remoteMessageId)
    )).orderBy(desc(reminderJobs.updatedAt));
    const oldCardByTask = new Map<string, string>();
    for (const row of oldCards) {
      if (row.taskId && row.messageId && !oldCardByTask.has(row.taskId)) oldCardByTask.set(row.taskId, row.messageId);
    }

    try {
      const applied = await this.taskService.bulkShift(
        candidate.localDate,
        candidate.offsetMinutes,
        candidate.adjustments.map(({ taskId, expectedVersion, expectedScheduleRevision }) => ({ taskId, expectedVersion, expectedScheduleRevision }))
      );
      const confirmed = await this.transition(claimed.id, claimed.version, "confirming", "confirmed", { resolvedAt: new Date() });
      if (!confirmed) throw new Error("plan_shift_confirmation_state_changed");
      return {
        type: "success",
        message: `已${candidate.offsetMinutes > 0 ? "顺延" : "提前"} ${applied.tasks.length} 项任务。`,
        card: planShiftCompletedCard(candidate),
        relatedCardUpdates: applied.tasks.flatMap((task) => {
          const messageId = oldCardByTask.get(task.id);
          return messageId ? [{ messageId, card: rescheduledReminderCard(task) }] : [];
        })
      };
    } catch (error) {
      if (await this.planShiftAlreadyApplied(candidate)) {
        await this.transition(claimed.id, claimed.version, "confirming", "confirmed", { resolvedAt: new Date() });
        return { type: "success", message: "这组排期已经调整完成。", card: planShiftCompletedCard(candidate) };
      }
      const reason = error instanceof TaskTimeConflictError
        ? "调整后会与未选中的任务重叠"
        : error instanceof BulkShiftValidationError || error instanceof TaskVersionConflictError || error instanceof ConflictSetChangedError
          ? "预览后任务或排期已经变化"
          : "计划调整没有完成";
      await this.transition(claimed.id, claimed.version, "confirming", "needs_desktop", { lastError: reason, resolvedAt: new Date() });
      return {
        type: "error",
        message: `${reason}，整组任务均未修改。请重新发送指令生成最新预览。`,
        card: planShiftFailedCard(candidate, reason)
      };
    }
  }

  private async planShiftAlreadyApplied(candidate: PlanShiftCandidate): Promise<boolean> {
    const current = await Promise.all(candidate.adjustments.map((item) => this.taskService.get(item.taskId).catch(() => null)));
    return current.every((detail, index) => {
      const expected = candidate.adjustments[index]!;
      return detail?.task.scheduleRevision === expected.expectedScheduleRevision + 1
        && detail.task.startAt?.toISOString() === expected.nextStartAt
        && detail.task.endAt?.toISOString() === expected.nextEndAt;
    });
  }

  private async receiveHealthMessage(message: FeishuTextMessage, content: string): Promise<FeishuIntakeReply> {
    if (!this.healthConversation) return { kind: "text", text: "健康页的飞书同步尚未启用；请先在桌面软件的健康栏目中继续交流。" };
    if (await this.healthConversation.service.hasExternalMessage(message.messageId)) return { kind: "none" };
    const localDate = localDateAtTimeZone(new Date(), this.config.timeZone);
    const weekStart = healthWeekStartFor(localDate);
    const opened = await this.healthConversation.service.getOrOpen(weekStart);
    await this.healthConversation.service.saveUserMessage(opened.conversation.id, content, "feishu", message.messageId);
    try {
      const replied = await this.healthConversation.service.retryLast(opened.conversation.id, this.healthConversation.responder);
      const assistant = [...replied.messages].reverse().find((item) => item.role === "assistant");
      return { kind: "text", text: assistant?.content ?? "补充已经保存到本周健康交流。请回到健康栏目生成候选。" };
    } catch (error) {
      if (error instanceof HealthConversationReplyUnavailableError) {
        return { kind: "text", text: "你的补充已经保存到本周健康交流，但 AI 暂时没有回应。回到健康栏目即可直接重试，不需要重新输入。" };
      }
      if (error instanceof HealthConversationNoPendingReplyError) return { kind: "none" };
      throw error;
    }
  }

  private async completeDurationFollowUp(
    current: StoredFeishuIntakeCandidate,
    message: FeishuTextMessage,
    text: string
  ): Promise<FeishuIntakeReply> {
    try {
      const candidate = await this.parser.parse({
        text: `原始安排：${current.rawText}\n用户补充时长：${text}\n请保留原任务内容和开始时间，只根据补充回答计算固定结束时间。`,
        referenceDate: localDateAtTimeZone(new Date(), this.config.timeZone),
        timeZone: this.config.timeZone
      });
      const state = needsDuration(candidate) ? "awaiting_duration" : requiresDesktop(candidate) ? "needs_desktop" : "pending";
      const [updated] = await this.db.update(feishuIntakeCandidates).set({
        candidate,
        state,
        rawText: `${current.rawText}\n时长补充：${text}`,
        lastSourceMessageId: message.messageId,
        version: current.version + 1,
        updatedAt: new Date()
      }).where(and(
        eq(feishuIntakeCandidates.id, current.id),
        eq(feishuIntakeCandidates.version, current.version),
        eq(feishuIntakeCandidates.state, "awaiting_duration")
      )).returning();
      if (!updated) return { kind: "none" };
      if (state === "awaiting_duration") {
        return { kind: "text", text: "我还没有读出明确时长。请直接回复“30 分钟”“1 小时”或“1 个半小时”。" };
      }
      if (state === "needs_desktop") {
        return { kind: "text", text: "时长已收到，但日期或具体开始时间仍不完整；当前没有自动创建任务。" };
      }
      return { kind: "card", card: candidateCard(updated, candidate) };
    } catch {
      await this.db.update(feishuIntakeCandidates).set({
        lastSourceMessageId: message.messageId,
        lastError: "无法从补充消息解析任务时长",
        version: current.version + 1,
        updatedAt: new Date()
      }).where(and(
        eq(feishuIntakeCandidates.id, current.id),
        eq(feishuIntakeCandidates.version, current.version),
        eq(feishuIntakeCandidates.state, "awaiting_duration")
      ));
      return { kind: "text", text: "我还没有读出明确时长。请直接回复“30 分钟”“1 小时”或“1 个半小时”。" };
    }
  }

  /** Recover only an interrupted confirmation; this never creates a task by itself. */
  async recoverInterruptedConfirmations(): Promise<void> {
    const interrupted = await this.db.select().from(feishuIntakeCandidates)
      .where(eq(feishuIntakeCandidates.state, "confirming"));
    for (const candidate of interrupted) {
      const planShift = parsePlanShiftCandidate(candidate.candidate);
      if (planShift) {
        if (await this.planShiftAlreadyApplied(planShift)) {
          await this.transition(candidate.id, candidate.version, "confirming", "confirmed", { resolvedAt: new Date() });
        } else {
          await this.transition(candidate.id, candidate.version, "confirming", "pending", {
            lastError: "应用在确认过程中退出；请重新生成预览",
            resolvedAt: undefined
          });
        }
        continue;
      }
      const targetExists = candidate.targetTaskId
        ? await this.getTask(candidate.targetTaskId)
        : candidate.targetInboxEntryId
          ? await this.getInboxEntry(candidate.targetInboxEntryId)
          : null;
      if (targetExists) {
        await this.transition(candidate.id, candidate.version, "confirming", "confirmed", { resolvedAt: new Date() });
      } else {
        await this.transition(candidate.id, candidate.version, "confirming", "pending", {
          lastError: "应用在确认过程中退出；可再次确认",
          resolvedAt: undefined
        });
      }
    }
  }

  async handleCardAction(operatorOpenId: string | undefined, value: unknown): Promise<FeishuIntakeActionResult> {
    if (operatorOpenId !== this.config.targetOpenId) throw new FeishuIntakeAuthError("card operator does not match the configured single user");
    const action = actionSchema.safeParse(value);
    if (!action.success) throw new FeishuIntakePayloadError("invalid Feishu intake action payload");
    const current = await this.get(action.data.candidateId);
    if (!current || current.operatorOpenId !== operatorOpenId) return { type: "error", message: "这条录入候选不存在或不属于当前用户。" };
    const planShift = parsePlanShiftCandidate(current.candidate);
    if (action.data.action === "plan_shift_cancel" || action.data.action === "plan_shift_confirm" || planShift) {
      if (!planShift) return { type: "error", message: "这条计划调整预览已经失效，请重新发送指令。" };
      return this.handlePlanShiftAction(current, planShift, action.data);
    }

    if (action.data.action === "intake_cancel") {
      if (current.state === "cancelled") return { type: "success", message: "这条候选已放弃，没有创建任何任务。" };
      if (current.state !== "pending" || current.version !== action.data.expectedVersion) {
        return { type: "error", message: stateMessage(current.state) };
      }
      const cancelled = await this.transition(current.id, current.version, "pending", "cancelled", {});
      return cancelled
        ? { type: "success", message: "已放弃这条候选，没有创建任何任务。" }
        : { type: "error", message: "候选状态已变化，请打开软件查看。" };
    }

    if (current.state === "confirmed") return confirmedMessage(current);
    if (current.state === "needs_desktop" || current.state === "failed" || current.state === "cancelled") {
      return { type: "error", message: stateMessage(current.state) };
    }

    let confirming = current;
    if (current.state === "pending") {
      const resumable = Boolean(current.targetTaskId || current.targetInboxEntryId);
      if (current.version !== action.data.expectedVersion && !resumable) {
        return { type: "error", message: "候选内容已经变化，请在软件中查看最新内容。" };
      }
      const target = resumable
        ? { targetTaskId: current.targetTaskId, targetInboxEntryId: current.targetInboxEntryId }
        : targetsFor(current);
      const claimed = await this.claim(current.id, current.version, target);
      if (!claimed) {
        const afterClaim = await this.get(current.id);
        if (!afterClaim) return { type: "error", message: "候选不存在，请在软件中重新录入。" };
        if (afterClaim.state === "confirmed") return confirmedMessage(afterClaim);
        if (afterClaim.state !== "confirming") return { type: "error", message: stateMessage(afterClaim.state) };
        confirming = afterClaim;
      } else {
        confirming = claimed;
      }
    }

    if (confirming.state !== "confirming") return { type: "error", message: stateMessage(confirming.state) };
    return this.completeConfirmation(confirming);
  }

  private async completeConfirmation(current: StoredFeishuIntakeCandidate): Promise<FeishuIntakeActionResult> {
    const candidate = parseCandidate(current.candidate);
    if (!candidate) {
      await this.transition(current.id, current.version, "confirming", "failed", { lastError: "候选内容无法读取", resolvedAt: new Date() });
      return { type: "error", message: "候选内容无法读取，请在桌面软件中重新录入。" };
    }

    try {
      if (candidate.entryType === "task") {
        const input = candidateToTaskInput(candidate, this.config.timeZone);
        if (!input || !current.targetTaskId) return this.needsDesktop(current, "任务排期不完整");
        const existing = await this.getTask(current.targetTaskId);
        if (!existing) await this.taskService.createFromFeishu(input, current.targetTaskId);
        const confirmed = await this.transition(current.id, current.version, "confirming", "confirmed", { resolvedAt: new Date() });
        return confirmed ? confirmedMessage(confirmed) : this.confirmationStateAfterRace(current.id);
      }

      if (!current.targetInboxEntryId) return this.needsDesktop(current, "想法或问题缺少保存目标");
      const existing = await this.getInboxEntry(current.targetInboxEntryId);
      if (!existing) await this.taskService.createInboxFromFeishu(candidate.entryType, candidate.title, candidate.notes, current.targetInboxEntryId);
      const confirmed = await this.transition(current.id, current.version, "confirming", "confirmed", { resolvedAt: new Date() });
      return confirmed ? { type: "success", message: candidate.entryType === "idea" ? "已保存为想法，尚未创建任务。" : "已保存为待处理问题，尚未创建任务。" } : this.confirmationStateAfterRace(current.id);
    } catch (error) {
      if (error instanceof TaskTimeConflictError || error instanceof ConflictSetChangedError || error instanceof TaskScheduleWindowError) {
        return this.needsDesktop(current, "排期需要在桌面端确认");
      }
      if (isUniqueViolation(error)) {
        return this.completeConfirmation(await this.require(current.id));
      }
      await this.transition(current.id, current.version, "confirming", "failed", {
        lastError: "创建记录时发生异常",
        resolvedAt: new Date()
      });
      return { type: "error", message: "保存未完成，原始内容没有被自动写入任务；请在桌面软件中重新录入。" };
    }
  }

  private async confirmationStateAfterRace(id: string): Promise<FeishuIntakeActionResult> {
    const current = await this.get(id);
    return current?.state === "confirmed"
      ? confirmedMessage(current)
      : { type: "error", message: "保存状态正在同步，请在软件中查看结果。" };
  }

  private async needsDesktop(current: StoredFeishuIntakeCandidate, reason: string): Promise<FeishuIntakeActionResult> {
    await this.transition(current.id, current.version, "confirming", "needs_desktop", { lastError: reason, resolvedAt: new Date() });
    return { type: "error", message: "这条任务需要在桌面软件中补全或调整时间冲突；飞书不会替你自动保存。" };
  }

  private async require(id: string): Promise<StoredFeishuIntakeCandidate> {
    const current = await this.get(id);
    if (!current) throw new Error("Feishu intake candidate disappeared.");
    return current;
  }

  private async createReceived(message: FeishuTextMessage, text: string): Promise<StoredFeishuIntakeCandidate | null> {
    const [created] = await this.db.insert(feishuIntakeCandidates).values({
      id: randomUUID(),
      chatId: message.chatId,
      operatorOpenId: message.operatorOpenId,
      sourceMessageId: message.messageId,
      lastSourceMessageId: message.messageId,
      rawText: text,
      state: "parsing",
      version: 1
    }).onConflictDoNothing().returning();
    return created ?? null;
  }

  private async findAwaitingDuration(chatId: string, operatorOpenId: string): Promise<StoredFeishuIntakeCandidate | null> {
    const [candidate] = await this.db.select().from(feishuIntakeCandidates).where(and(
      eq(feishuIntakeCandidates.chatId, chatId),
      eq(feishuIntakeCandidates.operatorOpenId, operatorOpenId),
      eq(feishuIntakeCandidates.state, "awaiting_duration")
    )).orderBy(desc(feishuIntakeCandidates.updatedAt)).limit(1);
    return candidate ?? null;
  }

  private async hasProcessedMessage(messageId: string): Promise<boolean> {
    const [candidate] = await this.db.select({ id: feishuIntakeCandidates.id }).from(feishuIntakeCandidates).where(or(
      eq(feishuIntakeCandidates.sourceMessageId, messageId),
      eq(feishuIntakeCandidates.lastSourceMessageId, messageId)
    )).limit(1);
    return Boolean(candidate);
  }

  private async startedReminderMessageId(taskId: string): Promise<string | null> {
    const [job] = await this.db.select({ remoteMessageId: reminderJobs.remoteMessageId }).from(reminderJobs).where(and(
      eq(reminderJobs.taskId, taskId),
      or(eq(reminderJobs.kind, "task_start_ready"), eq(reminderJobs.kind, "task_start")),
      isNotNull(reminderJobs.remoteMessageId)
    )).orderBy(desc(reminderJobs.updatedAt)).limit(1);
    return job?.remoteMessageId ?? null;
  }

  private async get(id: string): Promise<StoredFeishuIntakeCandidate | null> {
    const [candidate] = await this.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, id)).limit(1);
    return candidate ?? null;
  }

  private async getTask(id: string) {
    const [task] = await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1);
    return task ?? null;
  }

  private async getInboxEntry(id: string) {
    const [entry] = await this.db.select({ id: inboxEntries.id }).from(inboxEntries).where(eq(inboxEntries.id, id)).limit(1);
    return entry ?? null;
  }

  private async saveParsed(id: string, candidate: NaturalLanguageTaskCandidate, state: "awaiting_duration" | "pending" | "needs_desktop") {
    const [saved] = await this.db.update(feishuIntakeCandidates).set({
      candidate,
      state,
      version: sql`${feishuIntakeCandidates.version} + 1`,
      updatedAt: new Date()
    }).where(and(eq(feishuIntakeCandidates.id, id), eq(feishuIntakeCandidates.state, "parsing"))).returning();
    return saved ?? null;
  }

  private async markFailed(id: string, error: string): Promise<void> {
    await this.db.update(feishuIntakeCandidates).set({
      state: "failed",
      lastError: error,
      resolvedAt: new Date(),
      version: sql`${feishuIntakeCandidates.version} + 1`,
      updatedAt: new Date()
    }).where(and(eq(feishuIntakeCandidates.id, id), eq(feishuIntakeCandidates.state, "parsing")));
  }

  private async claim(id: string, expectedVersion: number, target: { targetTaskId: string | null; targetInboxEntryId: string | null }) {
    const [claimed] = await this.db.update(feishuIntakeCandidates).set({
      ...target,
      state: "confirming",
      version: expectedVersion + 1,
      updatedAt: new Date()
    }).where(and(
      eq(feishuIntakeCandidates.id, id),
      eq(feishuIntakeCandidates.state, "pending"),
      eq(feishuIntakeCandidates.version, expectedVersion)
    )).returning();
    return claimed ?? null;
  }

  private async transition(
    id: string,
    expectedVersion: number,
    from: FeishuIntakeState,
    state: FeishuIntakeState,
    changes: { lastError?: string; resolvedAt?: Date }
  ) {
    const [updated] = await this.db.update(feishuIntakeCandidates).set({
      state,
      version: expectedVersion + 1,
      updatedAt: new Date(),
      ...changes
    }).where(and(
      eq(feishuIntakeCandidates.id, id),
      eq(feishuIntakeCandidates.version, expectedVersion),
      eq(feishuIntakeCandidates.state, from)
    )).returning();
    return updated ?? null;
  }
}

export function loadFeishuIntakeConfig(env: NodeJS.ProcessEnv): FeishuIntakeConfig | null {
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  const workBuddySenderIds = [...new Set((env.FEISHU_WORK_BUDDY_SENDER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
  return targetOpenId ? { targetOpenId, timeZone: "Asia/Shanghai", workBuddySenderIds } : null;
}

function healthWeekStartFor(localDate: string): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

function requiresDesktop(candidate: NaturalLanguageTaskCandidate): boolean {
  if (candidate.entryType !== "task") return false;
  return !candidateToTaskInput(candidate, "Asia/Shanghai");
}

function needsDuration(candidate: NaturalLanguageTaskCandidate): boolean {
  return candidate.entryType === "task"
    && candidate.schedulePrecision === "exact"
    && Boolean(candidate.startAt)
    && !candidate.endAt;
}

function intakeFailureDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown AI parser failure";
  return `AI 整理失败：${detail.replace(/\s+/g, " ").trim().slice(0, 900)}`;
}

function candidateToTaskInput(candidate: NaturalLanguageTaskCandidate, timeZone: "Asia/Shanghai"): TaskInput | null {
  if (candidate.entryType !== "task") return null;
  if (candidate.schedulePrecision === "exact" && candidate.startAt && candidate.endAt) {
    return {
      title: candidate.title,
      scheduleKind: "exact",
      startAt: candidate.startAt,
      endAt: candidate.endAt,
      timeZone,
      notes: candidate.notes,
      conflictDecision: "reject"
    };
  }
  if (candidate.date && (candidate.schedulePrecision === "morning" || candidate.schedulePrecision === "afternoon" || candidate.schedulePrecision === "evening")) {
    return {
      title: candidate.title,
      scheduleKind: "daypart",
      localDate: candidate.date,
      daypart: candidate.schedulePrecision,
      timeZone,
      notes: candidate.notes,
      conflictDecision: "reject"
    };
  }
  return null;
}

function targetsFor(candidate: StoredFeishuIntakeCandidate) {
  const parsed = parseCandidate(candidate.candidate);
  if (!parsed) throw new FeishuIntakePayloadError("candidate content is invalid");
  return parsed.entryType === "task"
    ? { targetTaskId: randomUUID(), targetInboxEntryId: null }
    : { targetTaskId: null, targetInboxEntryId: randomUUID() };
}

function parseCandidate(value: unknown): NaturalLanguageTaskCandidate | null {
  const parsed = naturalLanguageTaskCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function candidateCard(record: StoredFeishuIntakeCandidate, candidate: NaturalLanguageTaskCandidate) {
  return {
    config: { wide_screen_mode: true },
    header: { template: candidate.entryType === "task" ? "blue" : "turquoise", title: { tag: "plain_text", content: "确认快捷录入" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: candidateSummary(candidate) } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: candidate.entryType === "task" ? "确认创建任务" : "确认保存" }, type: "primary", value: { action: "intake_confirm", candidateId: record.id, expectedVersion: record.version } },
          { tag: "button", text: { tag: "plain_text", content: "放弃" }, value: { action: "intake_cancel", candidateId: record.id, expectedVersion: record.version } }
        ]
      }
    ]
  };
}

function parsePlanShiftCandidate(value: unknown): PlanShiftCandidate | null {
  const parsed = planShiftCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function selectPlanShiftAdjustments(
  instruction: string,
  adjustments: BulkShiftAdjustment[],
  timeZone: string
): { adjustments: BulkShiftAdjustment[]; error?: string } {
  const normalized = normalizePlanText(instruction);
  let selected = adjustments;
  const afterMinute = planShiftAfterMinute(instruction);
  if (afterMinute !== null) {
    selected = selected.filter((item) => localMinute(item.currentStartAt, timeZone) >= afterMinute);
  }
  if (/(?:所有|全部|整体|全都)/u.test(normalized)) return { adjustments: selected };

  const subject = instruction.match(/把\s*(.+?)\s*(?:都\s*)?(?:往后|向后|顺延|推后|提前|往前|前移)/u)?.[1]
    ?.replace(/^(?:今天|今日|明天|后天|\d{4}-\d{2}-\d{2})(?:的)?/u, "")
    .trim();
  if (!subject) return { adjustments: [], error: "没有确定要调整哪些任务；请写明任务名称，或明确说“所有任务”。" };
  const fragments = subject.split(/[、，,和与及]/u).map(normalizePlanText).filter((item) => item && !/(?:任务|项目)$/.test(item));
  const ids = new Set<string>();
  for (const fragment of fragments.length > 0 ? fragments : [normalizePlanText(subject)]) {
    const matches = selected.filter((item) => normalizePlanText(item.title).includes(fragment) || fragment.includes(normalizePlanText(item.title)));
    if (matches.length !== 1) {
      return {
        adjustments: [],
        error: matches.length > 1
          ? `“${fragment}”对应多个任务，请使用更完整的任务名称。`
          : `没有找到与“${fragment}”匹配的可调整任务，请检查名称和日期。`
      };
    }
    ids.add(matches[0]!.taskId);
  }
  return { adjustments: selected.filter((item) => ids.has(item.taskId)) };
}

function normalizePlanText(value: string): string {
  return value.replace(/[\s：:。！？!?；;“”"']/gu, "");
}

function planShiftAfterMinute(value: string): number | null {
  const match = value.match(/(?:(上午|下午|晚上)\s*)?(\d{1,2})(?:[:：点时]\s*(\d{1,2})?\s*分?)?\s*(?:以后|之后|起)/u);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  if ((match[1] === "下午" || match[1] === "晚上") && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function localMinute(value: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(value));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60
    + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

function planShiftPreviewCard(record: StoredFeishuIntakeCandidate, candidate: PlanShiftCandidate, skipped: Array<{ title: string; reason: string }>) {
  const direction = candidate.offsetMinutes > 0 ? "顺延" : "提前";
  const lines = candidate.adjustments.slice(0, 20).map((item) => `• **${item.title}**\n${formatRange(item.currentStartAt, item.currentEndAt)} → ${formatRange(item.nextStartAt, item.nextEndAt)}`);
  const remaining = candidate.adjustments.length - lines.length;
  const skippedText = skipped.length > 0
    ? `\n\n不会移动：\n${skipped.slice(0, 6).map((item) => `• ${item.title}：${item.reason}`).join("\n")}`
    : "";
  return {
    config: { wide_screen_mode: true },
    header: { template: "orange", title: { tag: "plain_text", content: "确认批量调整排期" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `${dateLabel(candidate.localDate)} · ${direction} ${Math.abs(candidate.offsetMinutes)} 分钟 · ${candidate.adjustments.length} 项\n\n${lines.join("\n")}${remaining > 0 ? `\n另有 ${remaining} 项将在同一批次调整。` : ""}${skippedText}\n\n确认前没有修改任何任务。` } },
      { tag: "action", actions: [
        { tag: "button", text: { tag: "plain_text", content: `确认${direction}` }, type: "primary", value: { action: "plan_shift_confirm", candidateId: record.id, expectedVersion: record.version } },
        { tag: "button", text: { tag: "plain_text", content: "放弃" }, value: { action: "plan_shift_cancel", candidateId: record.id, expectedVersion: record.version } }
      ] }
    ]
  };
}

function planShiftCompletedCard(candidate: PlanShiftCandidate) {
  const direction = candidate.offsetMinutes > 0 ? "顺延" : "提前";
  return {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: "排期已更新" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: `${dateLabel(candidate.localDate)}的 ${candidate.adjustments.length} 项任务已${direction} ${Math.abs(candidate.offsetMinutes)} 分钟。\n所有变更已整批保存。` } }]
  };
}

function planShiftCancelledCard(candidate: PlanShiftCandidate) {
  return {
    config: { wide_screen_mode: true },
    header: { template: "grey", title: { tag: "plain_text", content: "已放弃计划调整" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: `${dateLabel(candidate.localDate)}的任务排期保持不变。` } }]
  };
}

function planShiftFailedCard(candidate: PlanShiftCandidate, reason: string) {
  return {
    config: { wide_screen_mode: true },
    header: { template: "red", title: { tag: "plain_text", content: "排期未修改" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: `${reason}。${candidate.adjustments.length} 项任务均未修改，请重新发送指令生成最新预览。` } }]
  };
}

function rescheduledReminderCard(task: Awaited<ReturnType<TaskService["get"]>>["task"]) {
  const schedule = task.startAt && task.endAt ? formatRange(task.startAt.toISOString(), task.endAt.toISOString()) : "未设置时间";
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "任务排期已更新" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${task.title}**\n新时间：${schedule}\n原提醒已失效，后续提醒将按新时间发送。` } },
      { tag: "action", actions: [
        { tag: "button", text: { tag: "plain_text", content: "另有安排" }, value: { action: "other_arrangement", taskId: task.id, scheduleRevision: task.scheduleRevision } },
        { tag: "button", text: { tag: "plain_text", content: "取消任务" }, type: "danger", value: { action: "cancel_request", taskId: task.id, scheduleRevision: task.scheduleRevision } }
      ] }
    ]
  };
}

function candidateSummary(candidate: NaturalLanguageTaskCandidate): string {
  const kind = candidate.entryType === "task" ? "任务" : candidate.entryType === "idea" ? "想法" : "待处理问题";
  const schedule = candidate.entryType === "task"
    ? candidate.schedulePrecision === "exact" && candidate.startAt && candidate.endAt
      ? `精确时间：${formatRange(candidate.startAt, candidate.endAt)}`
      : (candidate.schedulePrecision === "morning" || candidate.schedulePrecision === "afternoon" || candidate.schedulePrecision === "evening") && candidate.date
        ? `安排：${candidate.date} ${daypartLabel(candidate.schedulePrecision)}`
        : "安排：未完整识别"
    : "不会进入任务生命周期";
  return `${kind}\n${candidate.title}\n${schedule}${candidate.notes ? `\n备注：${candidate.notes}` : ""}`;
}

function formatRange(startAt: string, endAt: string): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${formatter.format(new Date(startAt))} - ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(endAt))}`;
}

function daypartLabel(value: "morning" | "afternoon" | "evening"): string {
  return value === "morning" ? "上午" : value === "afternoon" ? "下午" : "晚上";
}

function stateMessage(state: string): string {
  if (state === "awaiting_duration") return "这条任务还在等待你补充时长。";
  if (state === "confirmed") return "这条候选已经保存。";
  if (state === "cancelled") return "这条候选已经放弃。";
  if (state === "needs_desktop") return "这条内容需要在桌面软件中补全或处理冲突，飞书没有自动创建任务。";
  if (state === "failed") return "这条候选未能保存，请在桌面软件中手动录入。";
  return "这条候选正在处理，请稍后查看软件。";
}

function isFocusStartMessage(value: string): boolean {
  const text = value.replace(/[\s\u3000]+/gu, "").replace(/[。！？!?，,；;]+$/u, "");
  return [
    /^(?:我)?(?:已经|现在|刚刚|刚才|马上|立刻)?开始(?:了)?(?:这个|这项|该)?(?:任务|专注)$/u,
    /^(?:这个|这项|该)?任务(?:我)?(?:已经|现在|刚刚|刚才)?开始(?:了)?$/u,
    /^(?:现在|马上|立刻)开始(?:这个|这项|该)?(?:任务|专注)?$/u,
  ].some((pattern) => pattern.test(text));
}

function startedTaskCard(
  message: string,
  state?: string,
  task?: Awaited<ReturnType<TaskService["get"]>>["task"]
) {
  const schedule = task && task.startAt && task.endAt ? `\n${taskScheduleText(task)}` : "";
  return {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: "任务已经开始" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: `${task ? `**${task.title}**` : ""}${schedule}\n${message}` } }]
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

function confirmedMessage(candidate: StoredFeishuIntakeCandidate): FeishuIntakeActionResult {
  if (!candidate.targetTaskId) return { type: "success", message: "该想法或问题已经保存；尚未创建任务。" };
  const parsed = parseCandidate(candidate.candidate);
  if (!parsed || parsed.entryType !== "task") return { type: "success", message: "该任务已经创建；请在软件中查看对应日期。" };
  const schedule = confirmedSchedule(parsed);
  return {
    type: "success",
    message: `已创建：${schedule} · ${parsed.title}\n请在软件中切换到 ${confirmedDateLabel(parsed)} 查看。`
  };
}

function confirmedSchedule(candidate: NaturalLanguageTaskCandidate): string {
  if (candidate.schedulePrecision === "exact" && candidate.startAt && candidate.endAt) {
    const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" }).format(new Date(candidate.startAt));
    const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date} ${time.format(new Date(candidate.startAt))}-${time.format(new Date(candidate.endAt))}`;
  }
  if (candidate.date && (candidate.schedulePrecision === "morning" || candidate.schedulePrecision === "afternoon" || candidate.schedulePrecision === "evening")) {
    return `${dateLabel(candidate.date)} ${daypartLabel(candidate.schedulePrecision)}`;
  }
  return candidate.date ? dateLabel(candidate.date) : "未排期";
}

function confirmedDateLabel(candidate: NaturalLanguageTaskCandidate): string {
  if (candidate.date) return dateLabel(candidate.date);
  if (candidate.startAt) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" }).format(new Date(candidate.startAt));
  }
  return "任务列表";
}

function dateLabel(value: string): string {
  const [, month, day] = value.split("-").map(Number);
  return `${month}月${day}日`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
