import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SqlitePgClient, drizzleSqlite, migrateSqlite } from "./client.js";
import { openNodeSqlite } from "./node-driver.js";
import { translateStatement } from "./translate.js";
import { tasks, userProfiles } from "../schema.js";

const folder = resolve(import.meta.dirname, "../../drizzle");
const migrations = readdirSync(folder).filter((f) => f.endsWith(".sql")).sort().map((f) => ({ tag: f.replace(/\.sql$/, ""), sql: readFileSync(resolve(folder, f), "utf8") }));

async function openTestDatabase() {
  const client = new SqlitePgClient(openNodeSqlite(":memory:"));
  await migrateSqlite(client, migrations);
  return { client, db: drizzleSqlite(client) };
}

describe("phone SQLite layer", () => {
  it("creates every table from the PostgreSQL migrations and applies them only once", async () => {
    const { client } = await openTestDatabase();
    await migrateSqlite(client, migrations);
    const tables = (await client.raw("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r[0]);
    expect(tables).toContain("tasks");
    expect(tables).toContain("focus_sessions");
  });

  it("keeps the desktop's checks: exact tasks must sit on half hours", async () => {
    const { db } = await openTestDatabase();
    const base = { title: "t", scheduleKind: "exact" as const, localDate: "2026-11-23", timeZone: "Asia/Shanghai" };
    await db.insert(tasks).values({ ...base, id: crypto.randomUUID(), startAt: new Date("2026-11-23T01:00:00Z"), endAt: new Date("2026-11-23T01:30:00Z") });
    await expect(db.insert(tasks).values({ ...base, id: crypto.randomUUID(), startAt: new Date("2026-11-23T01:10:00Z"), endAt: new Date("2026-11-23T01:40:00Z") })).rejects.toMatchObject({ code: "23514" });
    await expect(db.insert(tasks).values({ ...base, id: crypto.randomUUID(), startAt: new Date("2026-11-23T01:00:00Z"), endAt: new Date("2026-11-23T01:00:00Z") })).rejects.toThrow(/CHECK/);
  });

  it("round-trips dates, booleans and defaults through drizzle", async () => {
    const { db } = await openTestDatabase();
    const id = crypto.randomUUID();
    const [row] = await db.insert(tasks).values({ id, title: "读书", scheduleKind: "exact", localDate: "2026-11-23", timeZone: "Asia/Shanghai", startAt: new Date("2026-11-23T01:00:00Z"), endAt: new Date("2026-11-23T02:00:00Z") }).returning();
    expect(row.startAt).toBeInstanceOf(Date);
    expect(row.startAt!.toISOString()).toBe("2026-11-23T01:00:00.000Z");
    expect(row.version).toBe(1);
    expect(row.createdAt).toBeInstanceOf(Date);
    const [updated] = await db.update(tasks).set({ title: "读完" }).where(eq(tasks.id, id)).returning();
    expect(updated.title).toBe("读完");
    const [profile] = await db.select().from(userProfiles);
    expect(profile.shareWithAi).toBe(false);
    expect(profile.focusFlipSoundEnabled).toBe(true);
  });

  it("rolls back a failed transaction", async () => {
    const { db } = await openTestDatabase();
    await expect(db.transaction(async (tx: any) => {
      await tx.update(userProfiles).set({ recycleRetentionDays: 9 });
      throw new Error("stop");
    })).rejects.toThrow("stop");
    const [profile] = await db.select().from(userProfiles);
    expect(profile.recycleRetentionDays).toBe(3);
  });

  it("rewrites the PostgreSQL-only constructs the services use", () => {
    const t = (sql: string, params: unknown[] = []) => translateStatement(sql, params) as { sql: string; params: unknown[] };
    expect(t("SELECT pg_advisory_xact_lock(hashtextextended('x', 0))").sql).toBe("SELECT 1");
    expect(t("SELECT id FROM tasks WHERE deleted_at <= CAST($1 AS timestamptz) - make_interval(days => CAST($2 AS integer)) LIMIT 25 FOR UPDATE SKIP LOCKED", [new Date("2026-11-23T00:00:00Z"), 3]).sql)
      .toBe("SELECT id FROM tasks WHERE deleted_at <= strftime('%Y-%m-%dT%H:%M:%fZ', (?), '-' || (CAST(? AS integer)) || ' days') LIMIT 25");
    expect(t("UPDATE tasks SET local_date = local_date + 1 WHERE local_date = $1::date", ["2026-11-22"]).sql).toBe("UPDATE tasks SET local_date = date(local_date, '+1 days') WHERE local_date = ?");
    expect(t("SELECT $1, $1, $2", ["a", true]).params).toEqual(["a", "a", 1]);
    expect(t("SELECT '2026-11-23 09:00:00+08'").sql).toBe("SELECT '2026-11-23T01:00:00.000Z'");
    expect(translateStatement("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")).toEqual({ skip: true });
  });
});
