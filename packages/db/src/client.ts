import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DatabaseConfig } from "./config.js";
import * as schema from "./schema.js";

export type AppDatabase = PgliteDatabase<typeof schema>;

export type DatabaseConnection = {
  /** Closes the embedded database; safe to call once on shutdown. */
  client: { end(): Promise<void> };
  db: AppDatabase;
  pglite: PGlite;
};

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

export function migrationsFolder(): string {
  return process.env.TMA_MIGRATIONS_DIR?.trim() || resolve(packageDirectory, "drizzle");
}

/**
 * Opens the embedded PostgreSQL (PGlite) database and brings its schema up to
 * date. Nothing needs to be installed on the user's computer: the data lives
 * in `config.dataDir`, or in memory when it is null.
 */
export async function openDatabase(config: DatabaseConfig): Promise<DatabaseConnection> {
  // The phone stores its data in SQLite; this runs the desktop API the same way so the
  // end-to-end tests can check the phone's database path. Not used by the desktop app.
  if (process.env.TMA_DB_ENGINE === "sqlite") {
    if (config.dataDir) mkdirSync(config.dataDir, { recursive: true });
    return openSqliteDatabase(config);
  }
  if (config.dataDir) mkdirSync(config.dataDir, { recursive: true });
  const pglite = await PGlite.create(config.dataDir ?? undefined);
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return {
    client: { end: () => pglite.close() },
    db,
    pglite
  };
}

/** Kept for callers written against the previous PostgreSQL client. */
export const connectVerifiedDatabase = openDatabase;

async function openSqliteDatabase(config: DatabaseConfig): Promise<DatabaseConnection> {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { SqlitePgClient, drizzleSqlite, migrateSqlite } = await import("./sqlite/index.js");
  const { openNodeSqlite } = await import("./sqlite/node-driver.js");
  const driver = openNodeSqlite(config.dataDir ? resolve(config.dataDir, "tma.sqlite") : ":memory:");
  const client = new SqlitePgClient(driver);
  const folder = migrationsFolder();
  const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const files = new Set(readdirSync(folder));
  await migrateSqlite(client, journal.entries.map((entry) => {
    if (!files.has(`${entry.tag}.sql`)) throw new Error(`Migration ${entry.tag} is missing`);
    return { tag: entry.tag, sql: readFileSync(resolve(folder, `${entry.tag}.sql`), "utf8") };
  }));
  return {
    client: { end: async () => driver.close() },
    db: drizzleSqlite(client) as AppDatabase,
    pglite: client as unknown as PGlite
  };
}
