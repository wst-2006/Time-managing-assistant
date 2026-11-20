import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { recordFocusNoResponseOutcome } from "@personal-ai/db/focus-no-response";

const waitingStates = ["scheduled", "reminded", "preparing", "armed", "awaiting_late_start", "awaiting_start"];

type OverdueTask = {
  id: string;
  startAt: Date | string;
  endAt: Date | string;
};

type WaitingSession = {
  id: string;
  state: string;
  version: number;
};

export class OverdueTaskWorker {
  constructor(private readonly db: AppDatabase) {}

  async processNext(now = new Date()): Promise<"idle" | "completed" | "skipped"> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as AppDatabase;
      const taskResult = await db.execute(sql`
        SELECT id, start_at AS "startAt", end_at AS "endAt"
        FROM tasks
        WHERE deleted_at IS NULL AND record_kind = 'formal'
          AND lifecycle_status = 'open' AND schedule_kind = 'exact'
          AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at <= ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM focus_sessions
            WHERE focus_sessions.task_id = tasks.id
              AND focus_sessions.planned_start_at = tasks.start_at
              AND focus_sessions.planned_end_at = tasks.end_at
              AND focus_sessions.state NOT IN ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start')
          )
        ORDER BY end_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const task = taskResult.rows[0] as OverdueTask | undefined;
      if (!task) return "idle";

      const startAt = new Date(task.startAt);
      const endAt = new Date(task.endAt);
      const sessionResult = await db.execute(sql`
        SELECT id, state, version
        FROM focus_sessions
        WHERE task_id = ${task.id}
          AND planned_start_at = ${startAt} AND planned_end_at = ${endAt}
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `);
      const session = sessionResult.rows[0] as WaitingSession | undefined;
      let sessionId = session?.id;
      if (session) {
        const ended = await db.execute(sql`
          UPDATE focus_sessions
          SET state = 'ended', started_at = NULL, active_since_at = NULL,
            ended_at = ${endAt}, raw_active_seconds = 0, effective_focus_seconds = 0,
            stopped_reason = '固定结束时间已过，未进入专注',
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${session.version}
            AND state IN ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start')
          RETURNING id
        `);
        if (ended.rows.length === 0) return "skipped";
      } else {
        const created = await db.execute(sql`
          INSERT INTO focus_sessions (
            id, task_id, state, planned_start_at, planned_end_at, ended_at,
            stopped_reason, raw_active_seconds, effective_focus_seconds, version, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${task.id}, 'ended', ${startAt}, ${endAt}, ${endAt},
            '固定结束时间已过，未进入专注', 0, 0, 1, ${now}, ${now}
          )
          RETURNING id
        `);
        sessionId = (created.rows[0] as { id?: string } | undefined)?.id;
      }
      if (!sessionId) return "skipped";

      const recorded = await recordFocusNoResponseOutcome(db, {
        taskId: task.id,
        focusSessionId: sessionId,
        now,
        reason: "固定结束时间已过，未进入专注",
      });
      return recorded ? "completed" : "skipped";
    });
  }
}
