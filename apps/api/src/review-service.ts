import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import {
  focusSessionSegmentRuns,
  focusSessions,
  reviewMessages,
  reviewSessions,
  taskFeedback,
  taskOutcomes,
  tasks,
} from "@personal-ai/db/schema";
import { indexFocusSecondsBySession, normalizeRecordedFocus } from "./focus-accounting.js";
import { reviewRadarSchema, reviewRadarSnapshotSchema, type ReviewRadar } from "@personal-ai/domain/review";

export class ReviewNotFoundError extends Error {}

export type ReviewRadarSnapshot = {
  id: string;
  reviewSessionId: string;
  radar: ReviewRadar;
  createdAt: string;
};

function parseRadarSnapshot(row: typeof reviewMessages.$inferSelect | undefined): ReviewRadarSnapshot | null {
  if (!row || row.source !== "radar") return null;
  try {
    const parsed = reviewRadarSnapshotSchema.parse(JSON.parse(row.content));
    return { id: row.id, reviewSessionId: row.reviewSessionId, radar: parsed.radar, createdAt: row.createdAt.toISOString() };
  } catch {
    return null;
  }
}

export class ReviewService {
  constructor(private readonly db: AppDatabase) {}

  async getOrOpen(localDate: string) {
    return this.db.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.localDate, localDate)).limit(1);
      const session = existing ?? (await transaction.insert(reviewSessions).values({ id: randomUUID(), localDate, state: "review_open" }).returning())[0]!;
      const messages = await transaction.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, session.id)).orderBy(asc(reviewMessages.createdAt));
      const taskRows = await transaction.select().from(tasks).where(and(eq(tasks.localDate, localDate), isNull(tasks.deletedAt))).orderBy(asc(tasks.createdAt));
      const taskIds = taskRows.map((task) => task.id);
      const outcomes = taskIds.length ? await transaction.select().from(taskOutcomes).where(inArray(taskOutcomes.taskId, taskIds)) : [];
      const focus = taskIds.length ? await transaction.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : [];
      const focusIds = focus.map((item) => item.id);
      const focusRuns = focusIds.length ? await transaction.select().from(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, focusIds)) : [];
      const focusSecondsBySession = indexFocusSecondsBySession(focusRuns);
      const feedback = taskIds.length ? await transaction.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : [];
      const radarSnapshot = parseRadarSnapshot([...messages].reverse().find((message) => message.source === "radar"));
      return { session, radarSnapshot, context: { tasks: taskRows, outcomes, focusSessions: focus.map((item) => normalizeRecordedFocus(item, focusSecondsBySession)), feedback } };
    });
  }

  async saveRadarSnapshot(sessionId: string, radar: ReviewRadar) {
    const parsedRadar = reviewRadarSchema.parse(radar);
    return this.db.transaction(async (transaction) => {
      const [session] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, sessionId)).limit(1);
      if (!session) throw new ReviewNotFoundError();
      const [existing] = await transaction.select().from(reviewMessages)
        .where(and(eq(reviewMessages.reviewSessionId, sessionId), eq(reviewMessages.source, "radar")))
        .orderBy(asc(reviewMessages.createdAt), asc(reviewMessages.id)).limit(1);
      const content = JSON.stringify({ version: 1, radar: parsedRadar });
      const now = new Date();
      const row = existing
        ? (await transaction.update(reviewMessages).set({ content, createdAt: now }).where(eq(reviewMessages.id, existing.id)).returning())[0]!
        : (await transaction.insert(reviewMessages).values({ id: randomUUID(), reviewSessionId: sessionId, source: "radar", content, createdAt: now }).returning())[0]!;
      const [updatedSession] = await transaction.update(reviewSessions).set({ updatedAt: now }).where(eq(reviewSessions.id, sessionId)).returning();
      return { session: updatedSession!, radarSnapshot: parseRadarSnapshot(row)! };
    });
  }
}
