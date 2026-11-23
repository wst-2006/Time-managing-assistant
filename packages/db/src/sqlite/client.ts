/**
 * A stand-in for PGlite that runs on SQLite. It offers the two calls drizzle
 * and the services use — query() and transaction() — so the phone app can run
 * the desktop's services unchanged on the database built into Android.
 */
import { entityKind, is } from "drizzle-orm/entity";
import { NoopLogger } from "drizzle-orm/logger";
import { PgBoolean, PgDatabase, PgDialect, PgTable, PgTransaction, getTableConfig } from "drizzle-orm/pg-core";
import { PgPreparedQuery, PgSession } from "drizzle-orm/pg-core/session";
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm/relations";
import { fillPlaceholders, sql } from "drizzle-orm/sql/sql";
// mapResultRow is exported at runtime but left out of the type declarations.
import * as drizzleUtils from "drizzle-orm/utils";
const mapResultRow = (drizzleUtils as any).mapResultRow as (fields: unknown, row: unknown[], joins: unknown) => unknown;
import * as schema from "../schema.js";
import { convertMigrationToSqlite } from "./ddl.js";
import { maskLiterals, rewriteExpressions, splitStatements, translateStatement, unmaskLiterals, type ColumnDefaults, type SqlValue } from "./translate.js";

export type { SqlValue } from "./translate.js";

/** What a platform must provide: run one statement, return its column names and rows as arrays. */
export interface SqliteDriver {
  query(sql: string, params: SqlValue[]): Promise<{ columns: string[]; rows: SqlValue[][]; changes?: number }>;
}

type QueryOptions = { rowMode?: "array" | "object"; parsers?: unknown };
type Result = { rows: any[]; fields: Array<{ name: string; dataTypeID: number }>; affectedRows: number };

// SQLite has no boolean type; values come back as 0/1.
const booleanMapper = function (this: unknown, value: unknown) { return typeof value === "number" ? value !== 0 : value; };
(PgBoolean.prototype as any).mapFromDriverValue = booleanMapper;

/** Column names (snake_case and camelCase) whose values must be turned back into booleans or JSON. */
const columnKinds = (() => {
  const types = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    for (const column of getTableConfig(value as PgTable).columns) {
      const camel = column.name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      for (const name of [column.name, camel]) {
        if (!types.has(name)) types.set(name, new Set());
        types.get(name)!.add(column.columnType);
      }
    }
  }
  // A name used with two different types (e.g. "content") is left alone; drizzle's own column mapping still applies.
  const only = (type: string) => new Set([...types].filter(([, set]) => set.size === 1 && set.has(type)).map(([name]) => name));
  const json = only("PgJsonb");
  for (const name of only("PgJson")) json.add(name);
  return { booleans: only("PgBoolean"), json };
})();

/** Each column's default as SQLite text, for INSERTs that say DEFAULT. */
const columnDefaults: ColumnDefaults = (() => {
  const dialect = new PgDialect();
  const out: ColumnDefaults = new Map();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value as PgTable);
    const table = new Map<string, string>();
    for (const column of config.columns) {
      const fallback = column.default;
      if (fallback === undefined || fallback === null) continue;
      let text: string;
      if (typeof fallback === "object" && fallback !== null && "queryChunks" in (fallback as object)) {
        const rendered = dialect.sqlToQuery(fallback as any).sql;
        const masked = maskLiterals(rendered);
        text = `(${unmaskLiterals(rewriteExpressions(masked.text, masked.literals), masked.literals)})`;
      } else if (typeof fallback === "boolean") text = fallback ? "1" : "0";
      else if (typeof fallback === "number") text = String(fallback);
      else if (fallback instanceof Date) text = `'${fallback.toISOString()}'`;
      else if (typeof fallback === "string") text = `'${fallback.replace(/'/g, "''")}'`;
      else text = `'${JSON.stringify(fallback).replace(/'/g, "''")}'`;
      table.set(column.name, text);
    }
    out.set(config.name, table);
  }
  return out;
})();

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** SQLite errors carry PostgreSQL's error codes too, for code that checks them. */
function asDatabaseError(error: unknown, statement: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${message}\nSQL: ${statement.slice(0, 500)}`, { cause: error }) as Error & { code?: string };
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(message)) wrapped.code = "23505";
  else if (/FOREIGN KEY constraint failed/i.test(message)) wrapped.code = "23503";
  else if (/CHECK constraint failed/i.test(message)) wrapped.code = "23514";
  else if (/NOT NULL constraint failed/i.test(message)) wrapped.code = "23502";
  else if (/database is locked|SQLITE_BUSY/i.test(message)) wrapped.code = "40001";
  return wrapped;
}

export class SqlitePgClient {
  private readonly mutex = new Mutex();
  constructor(private readonly driver: SqliteDriver) {}

  query(statement: string, params: unknown[] = [], options: QueryOptions = {}): Promise<Result> {
    return this.mutex.run(() => this.run(statement, params, options));
  }

  exec(script: string): Promise<Result[]> {
    return this.mutex.run(async () => {
      const results: Result[] = [];
      for (const statement of splitStatements(script)) results.push(await this.run(statement, [], {}));
      return results;
    });
  }

  /** One transaction at a time; other queries wait until it commits or rolls back. */
  transaction<T>(operation: (tx: { query: SqlitePgClient["query"]; exec: SqlitePgClient["exec"]; rollback(): Promise<void> }) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      await this.driver.query("BEGIN IMMEDIATE", []);
      const tx = {
        query: (statement: string, params: unknown[] = [], options: QueryOptions = {}) => this.run(statement, params, options),
        exec: async (script: string) => { const out: Result[] = []; for (const s of splitStatements(script)) out.push(await this.run(s, [], {})); return out; },
        rollback: async () => { throw new Error("Transaction rolled back"); }
      };
      try {
        const result = await operation(tx);
        await this.driver.query("COMMIT", []);
        return result;
      } catch (error) {
        await this.driver.query("ROLLBACK", []).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Runs statements outside the translation (table setup, PRAGMA). */
  raw(statement: string, params: SqlValue[] = []) {
    return this.mutex.run(() => this.driver.query(statement, params));
  }

  close(): Promise<void> { return Promise.resolve(); }

  private async run(statement: string, params: unknown[], options: QueryOptions): Promise<Result> {
    const translated = translateStatement(statement, params, columnDefaults);
    if (translated.skip) return { rows: [], fields: [], affectedRows: 0 };
    let response;
    try {
      response = await this.driver.query(translated.sql, translated.params);
    } catch (error) {
      const wrapped = asDatabaseError(error, translated.sql);
      if (typeof process !== "undefined" && process.env?.TMA_SQLITE_DEBUG) console.error("[sqlite]", wrapped.message, "\nPG:", statement.slice(0, 400));
      throw wrapped;
    }
    const fields = response.columns.map((name) => ({ name, dataTypeID: 0 }));
    const affectedRows = response.changes ?? 0;
    const restore = (name: string, value: SqlValue): unknown => {
      if (value !== null && typeof value === "number" && columnKinds.booleans.has(name)) return value !== 0;
      if (typeof value === "string" && columnKinds.json.has(name)) { try { return JSON.parse(value); } catch { return value; } }
      return value;
    };
    const arrays = response.rows.map((values) => values.map((value, i) => restore(response.columns[i]!, value)));
    if (options.rowMode === "array") return { rows: arrays, fields, affectedRows };
    const rows = arrays.map((values) => Object.fromEntries(response.columns.map((name, i) => [name, values[i]])));
    return { rows, fields, affectedRows };
  }
}

/* ---------- drizzle on top of SqlitePgClient (same as drizzle's PGlite driver, without PGlite) ---------- */

class SqlitePreparedQuery extends (PgPreparedQuery as any) {
  static readonly [entityKind] = "TmaSqlitePreparedQuery";
  constructor(private client: any, private queryString: string, private params: unknown[], private logger: any, private fields: any, private _isResponseInArrayMode: boolean, private customResultMapper?: (rows: unknown[][]) => unknown) {
    super({ sql: queryString, params });
  }
  async execute(placeholderValues: Record<string, unknown> = {}) {
    const params = fillPlaceholders(this.params as any, placeholderValues);
    this.logger.logQuery(this.queryString, params);
    const { fields, client, customResultMapper, queryString } = this;
    if (!fields && !customResultMapper) return client.query(queryString, params, { rowMode: "object" });
    const result = await client.query(queryString, params, { rowMode: "array" });
    return customResultMapper ? customResultMapper(result.rows) : result.rows.map((row: unknown[]) => mapResultRow(fields, row, (this as any).joinsNotNullableMap));
  }
  async all(placeholderValues: Record<string, unknown> = {}) {
    const params = fillPlaceholders(this.params as any, placeholderValues);
    return this.client.query(this.queryString, params, { rowMode: "object" }).then((result: Result) => result.rows);
  }
  isResponseInArrayMode() { return this._isResponseInArrayMode; }
}

class SqliteSession extends (PgSession as any) {
  static readonly [entityKind] = "TmaSqliteSession";
  logger: any;
  constructor(private client: any, dialect: PgDialect, private schema: any, private options: { logger?: any } = {}) {
    super(dialect);
    this.logger = options.logger ?? new NoopLogger();
  }
  prepareQuery(query: { sql: string; params: unknown[] }, fields: unknown, _name: unknown, isResponseInArrayMode: boolean, customResultMapper?: (rows: unknown[][]) => unknown) {
    return new SqlitePreparedQuery(this.client, query.sql, query.params, this.logger, fields, isResponseInArrayMode, customResultMapper);
  }
  async transaction(operation: (tx: any) => Promise<unknown>, config?: unknown) {
    return this.client.transaction(async (client: any) => {
      const session = new SqliteSession(client, (this as any).dialect, this.schema, this.options);
      const tx = new (SqliteTransaction as any)((this as any).dialect, session, this.schema);
      if (config) await (tx as any).setTransaction(config);
      return operation(tx);
    });
  }
  async count(query: any) {
    const result = await (this as any).execute(query);
    return Number(result.rows[0].count);
  }
}

class SqliteTransaction extends (PgTransaction as any) {
  static readonly [entityKind] = "TmaSqliteTransaction";
  async transaction(operation: (tx: any) => Promise<unknown>) {
    const self = this as any;
    const name = `sp${self.nestedIndex + 1}`;
    const tx = new (SqliteTransaction as any)(self.dialect, self.session, self.schema, self.nestedIndex + 1);
    await (tx as any).execute(sql.raw(`savepoint ${name}`));
    try {
      const result = await operation(tx);
      await (tx as any).execute(sql.raw(`release savepoint ${name}`));
      return result;
    } catch (error) {
      await (tx as any).execute(sql.raw(`rollback to savepoint ${name}`));
      throw error;
    }
  }
}

/** A drizzle database with the same API the desktop's PGlite database has. */
export function drizzleSqlite(client: SqlitePgClient) {
  const dialect = new PgDialect();
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relational = { fullSchema: schema, schema: tablesConfig.tables, tableNamesMap: tablesConfig.tableNamesMap };
  const session = new SqliteSession(client, dialect, relational);
  const db = new (PgDatabase as any)(dialect, session, relational);
  db.$client = client;
  return db;
}

/* ---------- migrations ---------- */

export type MigrationFile = { tag: string; sql: string };

/** Creates or updates the tables from drizzle-kit's migration files, converted for SQLite. */
export async function migrateSqlite(client: SqlitePgClient, migrations: MigrationFile[]): Promise<void> {
  await client.raw("PRAGMA foreign_keys = ON");
  await client.raw("CREATE TABLE IF NOT EXISTS __tma_migrations (tag TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((await client.raw("SELECT tag FROM __tma_migrations")).rows.map((row) => String(row[0])));
  for (const migration of migrations) {
    if (applied.has(migration.tag)) continue;
    const statements = convertMigrationToSqlite(migration.sql);
    await client.transaction(async (tx) => {
      for (const statement of statements) await tx.query(statement);
      await tx.query("INSERT INTO __tma_migrations (tag, applied_at) VALUES ($1, $2)", [migration.tag, new Date()]);
    });
  }
}
