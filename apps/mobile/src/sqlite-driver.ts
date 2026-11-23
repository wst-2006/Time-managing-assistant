/** The native store (LocalSqlitePlugin.java) as the driver the shared SQLite layer expects. */
import { registerPlugin } from "@capacitor/core";
import type { SqliteDriver, SqlValue } from "../../../packages/db/src/sqlite/client";

type QueryResult = { columns: string[]; rows: SqlValue[][]; changes: number };
interface LocalSqlitePlugin {
  open(options: { name: string }): Promise<{ version: string }>;
  query(options: { sql: string; params: SqlValue[] }): Promise<QueryResult>;
}

const LocalSqlite = registerPlugin<LocalSqlitePlugin>("LocalSqlite");

export async function openPhoneSqlite(name: string): Promise<SqliteDriver & { version: string }> {
  const { version } = await LocalSqlite.open({ name });
  return {
    version,
    async query(sql, params) {
      // Blobs are not used; everything else crosses the bridge as JSON.
      return LocalSqlite.query({ sql, params });
    }
  };
}
