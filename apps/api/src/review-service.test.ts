import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { focusSessionSegmentRuns, focusSessions, focusStructures, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq, inArray } from "drizzle-orm";
import { ReviewService } from "./review-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new ReviewService(connection.db);
const reviewIds: string[] = [];
const taskIds: string[] = [];

afterEach(async () => {
  if (reviewIds.length) {
    const ids = reviewIds.splice(0);
    await connection.db.delete(reviewMessages).where(inArray(reviewMessages.reviewSessionId, ids));
    await connection.db.delete(reviewSessions).where(inArray(reviewSessions.id, ids));
  }
  if (taskIds.length) {
    const ids = taskIds.splice(0);
    await connection.db.delete(taskFeedback).where(inArray(taskFeedback.taskId, ids));
    await connection.db.delete(taskOutcomes).where(inArray(taskOutcomes.taskId, ids));
    const sessionRows = await connection.db.select({ id: focusSessions.id }).from(focusSessions).where(inArray(focusSessions.taskId, ids));
    if (sessionRows.length) await connection.db.delete(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionRows.map((row) => row.id)));
    await connection.db.delete(focusSessions).where(inArray(focusSessions.taskId, ids));
    await connection.db.delete(focusStructures).where(inArray(focusStructures.taskId, ids));
    await connection.db.delete(tasks).where(inArray(tasks.id, ids));
  }
});

afterAll(async () => { await connection.client.end(); });

describe("ReviewService day context", () => {
  it("reports only focus segments for an ended structured session before evaluation", async () => {
    const localDate = "2099-08-04";
    const taskId = randomUUID();
    const focusId = randomUUID();
    const structureId = randomUUID();
    taskIds.push(taskId);
    await connection.db.insert(tasks).values({
      id: taskId,
      title: "尚未评价但已经结束",
      lifecycleStatus: "awaiting_outcome",
      scheduleKind: "none",
      localDate,
      timeZone: "Asia/Shanghai"
    });
    await connection.db.insert(focusStructures).values({
      id: structureId,
      taskId,
      taskScheduleRevision: 1,
      state: "superseded",
      source: "manual",
      mode: "segmented",
      totalStartAt: new Date("2099-08-04T01:00:00.000Z"),
      totalEndAt: new Date("2099-08-04T02:00:00.000Z")
    });
    await connection.db.insert(focusSessions).values({
      id: focusId,
      taskId,
      focusStructureId: structureId,
      focusStructureVersion: 1,
      focusStructureScheduleRevision: 1,
      state: "ended",
      rawActiveSeconds: 3435,
      effectiveFocusSeconds: 0,
      endedAt: new Date("2099-08-04T02:00:00.000Z")
    });
    await connection.db.insert(focusSessionSegmentRuns).values([
      { id: randomUUID(), focusSessionId: focusId, position: 0, segmentType: "focus", plannedDurationSeconds: 3300, elapsedSeconds: 3300 },
      { id: randomUUID(), focusSessionId: focusId, position: 1, segmentType: "break", plannedDurationSeconds: 300, elapsedSeconds: 135 }
    ]);

    const loaded = await service.getOrOpen(localDate);
    reviewIds.push(loaded.session.id);

    expect(loaded.context.focusSessions[0]).toMatchObject({
      state: "ended",
      rawActiveSeconds: 3435,
      effectiveFocusSeconds: 3300
    });
  });


});
