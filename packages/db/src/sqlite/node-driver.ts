/**
 * SQLite through Node's built-in node:sqlite. Used to run the desktop API and
 * its end-to-end tests on the phone's database engine (TMA_DB_ENGINE=sqlite).
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqliteDriver, SqlValue } from "./client.js";

export function openNodeSqlite(path: string): SqliteDriver & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const statements = new Map<string, StatementSync>();
  const changes = db.prepare("SELECT changes()");
  changes.setReturnArrays(true);
  return {
    async query(sql: string, params: SqlValue[]) {
      let statement = statements.get(sql);
      if (!statement) {
        statement = db.prepare(sql);
        statement.setReturnArrays(true);
        if (statements.size > 500) statements.clear();
        statements.set(sql, statement);
      }
      const columns = statement.columns().map((column) => column.name);
      if (columns.length === 0) {
        const result = statement.run(...(params as any[]));
        return { columns, rows: [], changes: Number(result.changes) };
      }
      const rows = statement.all(...(params as any[])) as unknown as SqlValue[][];
      const writes = /^\s*(insert|update|delete|with)\b/i.test(sql);
      return { columns, rows, changes: writes ? Number((changes.all() as unknown as number[][])[0]![0]) : 0 };
    },
    close() { db.close(); }
  };
}
