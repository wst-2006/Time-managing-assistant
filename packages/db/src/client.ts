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
