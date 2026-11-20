import { describe, expect, it } from "vitest";
import { openDatabase } from "./client.js";

describe("embedded database", () => {
  it("applies every migration to a fresh in-memory database", async () => {
    const connection = await openDatabase({ dataDir: null });
    try {
      const result = await connection.pglite.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
      );
      const tables = result.rows.map((row) => row.table_name);
      for (const table of ["tasks", "focus_sessions", "task_outcomes", "review_sessions", "health_week_plans", "long_range_plans", "user_profiles"]) {
        expect(tables).toContain(table);
      }
      for (const removed of ["inbox_entries", "app_conversations", "cyber_diaries", "daily_briefs", "health_sleep_analyses"]) {
        expect(tables).not.toContain(removed);
      }
    } finally {
      await connection.client.end();
    }
  });
});
