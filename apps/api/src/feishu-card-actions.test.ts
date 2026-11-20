import { describe, expect, it, vi } from "vitest";
import type { FocusService } from "./focus-service.js";
import {
  FeishuActionAuthError,
  FeishuCardActionService,
  loadFeishuCardActionConfig
} from "./feishu-card-actions.js";
import type { TaskService } from "./task-service.js";

const taskId = "7f9a4ad8-4dc7-4d18-92df-1d8be780a1b1";

function service(
  createdState: "armed" | "running" = "armed",
  current: { id: string; taskId: string; version: number; state: string } | null = null
) {
  const task = {
    id: taskId,
    title: "整理产品原型",
    version: 8,
    scheduleRevision: 3,
    lifecycleStatus: "open",
    localDate: null,
    startAt: new Date("2099-08-15T07:00:00.000Z"),
    endAt: new Date("2099-08-15T08:00:00.000Z")
  };
  const taskService = {
    get: vi.fn().mockResolvedValue({ task }),
    update: vi.fn().mockResolvedValue({ task: { ...task, scheduleKind: "none" }, historicalOverlaps: [] }),
    cancel: vi.fn().mockResolvedValue({ ...task, lifecycleStatus: "cancelled" }),
    cancelAndTrash: vi.fn().mockResolvedValue({ ...task, lifecycleStatus: "cancelled", deletedAt: new Date() })
  };
  const focusService: {
    currentForTask: ReturnType<typeof vi.fn>;
    hasStartConfirmation: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    otherArrangement: ReturnType<typeof vi.fn>;
    resolvePreparationDecision: ReturnType<typeof vi.fn>;
  } = {
    currentForTask: vi.fn().mockResolvedValue(current),
    hasStartConfirmation: vi.fn().mockResolvedValue(false),
    create: vi.fn().mockResolvedValue({ id: "focus-1", taskId, version: 2, state: createdState }),
    otherArrangement: vi.fn().mockResolvedValue({ id: "focus-1", taskId, version: 3, state: "stopped_no_response" }),
    resolvePreparationDecision: vi.fn().mockResolvedValue({ id: "focus-1", taskId, version: 3, state: "stopped_for_change" })
  };
  return {
    taskService,
    focusService,
    actions: new FeishuCardActionService(
      { targetOpenId: "ou_owner" },
      taskService as unknown as TaskService,
      focusService as unknown as FocusService
    )
  };
}

describe("Feishu card actions", () => {
  it("clears the schedule before reporting success for an early reminder without a session", async () => {
    const { actions, taskService } = service();
    const result = await actions.handle("ou_owner", { action: "other_arrangement", taskId, scheduleRevision: 3 });
    expect(taskService.update).toHaveBeenCalledWith(taskId, expect.objectContaining({
      expectedVersion: 8, expectedScheduleRevision: 3,
      scheduleKind: "none", startAt: null, endAt: null, daypart: null,
    }));
    expect(result).toMatchObject({ type: "success", message: "任务已退回未排期列表。" });
    taskService.update.mockRejectedValueOnce(new Error("task_version_conflict"));
    const failed = await actions.handle("ou_owner", { action: "other_arrangement", taskId, scheduleRevision: 3 });
    expect(failed).toMatchObject({ type: "error" });
    expect(failed.card).toBeUndefined();
  });

  it("loads only the configured single-user target", () => {
    expect(loadFeishuCardActionConfig({ FEISHU_TARGET_OPEN_ID: "  ou_owner  " })).toEqual({ targetOpenId: "ou_owner" });
    expect(loadFeishuCardActionConfig({})).toBeNull();
  });

  it("rejects any operator except the configured owner", async () => {
    const { actions } = service();
    await expect(actions.handle("ou_other", { action: "start", taskId, scheduleRevision: 3 }))
      .rejects.toBeInstanceOf(FeishuActionAuthError);
  });

  it("arms an explicitly confirmed task and replaces every card action", async () => {
    const { actions, focusService } = service("armed");
    const commandId = "00000000-0000-4000-8000-000000000003";
    const result = await actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3, commandId });

    expect(result).toMatchObject({ type: "success", message: expect.stringContaining("任务已经开始"), card: expect.any(Object) });
    expect(JSON.stringify(result.card)).toContain("任务已经开始");
    expect(JSON.stringify(result.card)).toContain("开始：15:00");
    expect(JSON.stringify(result.card)).toContain("结束：16:00");
    expect(JSON.stringify(result.card)).not.toContain("另有安排");
    expect(JSON.stringify(result.card)).not.toContain("取消任务");
    expect(focusService.create).toHaveBeenCalledWith(taskId, 8, "prepare", commandId);
  });

  it("records an explicit start as running without backfilling", async () => {
    const { actions } = service("running", {
      id: "focus-late",
      taskId,
      version: 4,
      state: "awaiting_late_start"
    });
    await expect(actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3 }))
      .resolves.toMatchObject({ type: "success", message: expect.stringContaining("从现在计时") });
  });

  it("treats a repeated start for the same running task as idempotent success", async () => {
    const { actions, focusService } = service("armed", {
      id: "focus-running",
      taskId,
      version: 6,
      state: "running"
    });
    const result = await actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3 });

    expect(result).toMatchObject({ type: "success", card: expect.any(Object) });
    expect(JSON.stringify(result.card)).toContain("任务已经开始");
    expect(focusService.create).not.toHaveBeenCalled();
  });

  it("invalidates arrangement and cancellation controls immediately after confirmation", async () => {
    const { actions, taskService, focusService } = service("armed", {
      id: "focus-armed",
      taskId,
      version: 5,
      state: "armed"
    });
    const result = await actions.handle("ou_owner", { action: "other_arrangement", taskId, scheduleRevision: 3 });

    expect(result).toMatchObject({ type: "success", message: expect.stringContaining("操作已失效"), card: expect.any(Object) });
    expect(taskService.update).not.toHaveBeenCalled();
    expect(focusService.otherArrangement).not.toHaveBeenCalled();
  });

  it("returns preparation to unscheduled through the atomic focus decision", async () => {
    const { actions, taskService, focusService } = service("armed", {
      id: "focus-preparing",
      taskId,
      version: 4,
      state: "preparing"
    });
    const commandId = "00000000-0000-4000-8000-000000000004";
    const result = await actions.handle("ou_owner", { action: "other_arrangement", taskId, scheduleRevision: 3, commandId });

    expect(result).toMatchObject({ type: "success", message: "任务已退回未排期列表。", card: expect.any(Object) });
    expect(focusService.resolvePreparationDecision).toHaveBeenCalledWith("focus-preparing", 4, "other_arrangement", "飞书选择另有安排", expect.any(String));
    expect(taskService.update).not.toHaveBeenCalled();
    expect(JSON.stringify(result.card)).toContain("原时间已释放");
  });

  it("stops a late-start wait from the Feishu card", async () => {
    const { actions, taskService, focusService } = service("armed", {
      id: "focus-awaiting-late-arrangement",
      taskId,
      version: 7,
      state: "awaiting_late_start"
    });
    const resolvePreparationDecision = vi.fn().mockResolvedValue({
      id: "focus-awaiting-late-arrangement",
      taskId,
      version: 8,
      state: "stopped_for_change"
    });
    focusService.resolvePreparationDecision = resolvePreparationDecision;

    const result = await actions.handle("ou_owner", {
      action: "other_arrangement",
      taskId,
      scheduleRevision: 3,
      commandId: "00000000-0000-4000-8000-000000000007"
    });

    expect(result).toMatchObject({ type: "success", message: "任务已退回未排期列表。" });
    expect(resolvePreparationDecision).toHaveBeenCalledWith(
      "focus-awaiting-late-arrangement",
      7,
      "other_arrangement",
      "飞书选择另有安排",
      expect.any(String)
    );
    expect(taskService.update).not.toHaveBeenCalled();
  });

  it("refreshes a late-start session and retries when the fixed-start transition changes its version", async () => {
    const initial = { id: "focus-late-race", taskId, version: 4, state: "awaiting_late_start" };
    const refreshed = { ...initial, version: 5 };
    const { actions, focusService } = service("armed", initial);
    focusService.currentForTask
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    const resolvePreparationDecision = vi.fn()
      .mockRejectedValueOnce(new Error("Focus session version does not match."))
      .mockResolvedValueOnce({ ...refreshed, version: 6, state: "stopped_for_change" });
    focusService.resolvePreparationDecision = resolvePreparationDecision;

    await expect(actions.handle("ou_owner", {
      action: "other_arrangement",
      taskId,
      scheduleRevision: 3,
      commandId: "00000000-0000-4000-8000-000000000008"
    })).resolves.toMatchObject({ type: "success" });

    expect(resolvePreparationDecision).toHaveBeenNthCalledWith(
      1, initial.id, 4, "other_arrangement", "飞书选择另有安排", expect.any(String)
    );
    expect(resolvePreparationDecision).toHaveBeenNthCalledWith(
      2, refreshed.id, 5, "other_arrangement", "飞书选择另有安排", expect.any(String)
    );
  });

  it("requires a second cancellation confirmation and then replaces the card", async () => {
    const { actions, taskService } = service();
    const first = await actions.handle("ou_owner", { action: "cancel_request", taskId, scheduleRevision: 3 });
    expect(first).toMatchObject({ type: "success", card: expect.any(Object) });
    expect(JSON.stringify(first.card)).toContain("确认取消");
    expect(JSON.stringify(first.card)).toContain("开始：15:00");
    expect(JSON.stringify(first.card)).toContain("结束：16:00");
    expect(taskService.cancel).not.toHaveBeenCalled();

    const confirmed = await actions.handle("ou_owner", { action: "cancel_confirm", taskId, scheduleRevision: 3 });
    expect(confirmed).toMatchObject({ type: "success", message: "任务已取消并移入回收站。", card: expect.any(Object) });
    expect(taskService.cancelAndTrash).toHaveBeenCalledWith(taskId, 8, "飞书二次确认取消任务");
    expect(JSON.stringify(confirmed.card)).not.toContain("确认取消");
  });

  it("cancels a prepared task through the focus transaction and replaces the card", async () => {
    const { actions, taskService, focusService } = service("armed", {
      id: "focus-prepared-for-cancel",
      taskId,
      version: 6,
      state: "preparing"
    });
    const resolvePreparationDecision = vi.fn().mockResolvedValue({
      id: "focus-prepared-for-cancel",
      taskId,
      version: 7,
      state: "stopped_for_change"
    });
    focusService.resolvePreparationDecision = resolvePreparationDecision;

    const confirmed = await actions.handle("ou_owner", {
      action: "cancel_confirm",
      taskId,
      scheduleRevision: 3
    });

    expect(confirmed).toMatchObject({ type: "success", message: "任务已取消并移入回收站。", card: expect.any(Object) });
    expect(resolvePreparationDecision).toHaveBeenCalledWith(
      "focus-prepared-for-cancel",
      6,
      "cancel_task",
      "飞书二次确认取消任务",
      expect.any(String)
    );
    expect(taskService.cancelAndTrash).not.toHaveBeenCalled();
  });

  it("cancels an awaiting late-start task through the Feishu confirmation card", async () => {
    const { actions, taskService, focusService } = service("armed", {
      id: "focus-awaiting-late-cancel",
      taskId,
      version: 9,
      state: "awaiting_late_start"
    });
    const resolvePreparationDecision = vi.fn().mockResolvedValue({
      id: "focus-awaiting-late-cancel",
      taskId,
      version: 10,
      state: "stopped_for_change"
    });
    focusService.resolvePreparationDecision = resolvePreparationDecision;

    const first = await actions.handle("ou_owner", { action: "cancel_request", taskId, scheduleRevision: 3 });
    expect(JSON.stringify(first.card)).toContain("确认取消");
    const confirmed = await actions.handle("ou_owner", {
      action: "cancel_confirm",
      taskId,
      scheduleRevision: 3,
      commandId: "00000000-0000-4000-8000-000000000009"
    });

    expect(confirmed).toMatchObject({ type: "success", message: "任务已取消并移入回收站。" });
    expect(resolvePreparationDecision).toHaveBeenCalledWith(
      "focus-awaiting-late-cancel",
      9,
      "cancel_task",
      "飞书二次确认取消任务",
      "00000000-0000-4000-8000-000000000009"
    );
    expect(taskService.cancelAndTrash).not.toHaveBeenCalled();
  });

  it("repairs a stale cancellation card from the current deleted task state", async () => {
    const { actions, taskService } = service();
    taskService.get.mockResolvedValueOnce({
      task: {
        id: taskId,
        title: "整理产品原型",
        version: 9,
        scheduleRevision: 4,
        lifecycleStatus: "cancelled",
        scheduleKind: "exact",
        localDate: null,
        daypart: null,
        startAt: new Date("2099-08-15T07:00:00.000Z"),
        endAt: new Date("2099-08-15T08:00:00.000Z"),
        timeZone: "Asia/Shanghai",
        deletedAt: new Date("2099-08-15T06:30:00.000Z")
      }
    });

    const result = await actions.handle("ou_owner", { action: "cancel_request", taskId, scheduleRevision: 3 });

    expect(result.message).toContain("已取消");
    expect(JSON.stringify(result.card)).toContain("任务已取消");
    expect(JSON.stringify(result.card)).not.toContain("确认取消");
  });

  it("keeps an expired card after a stale old action is clicked", async () => {
    const { actions, taskService, focusService } = service();
    taskService.get.mockResolvedValueOnce({
      task: {
        id: taskId,
        title: "整理产品原型",
        version: 9,
        scheduleRevision: 4,
        lifecycleStatus: "closed",
        scheduleKind: "exact",
        localDate: null,
        daypart: null,
        startAt: new Date("2099-08-15T07:00:00.000Z"),
        endAt: new Date("2099-08-15T08:00:00.000Z"),
        timeZone: "Asia/Shanghai",
        deletedAt: null
      }
    });
    focusService.hasStartConfirmation.mockResolvedValueOnce(false);

    const result = await actions.handle("ou_owner", { action: "start", taskId, scheduleRevision: 3 });

    expect(result.message).toContain("已过时");
    expect(JSON.stringify(result.card)).toContain("任务已过时");
    expect(JSON.stringify(result.card)).not.toContain('"tag":"action"');
  });
});
