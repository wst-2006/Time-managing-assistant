/**
 * The same drizzle-kit migrations as the desktop app, bundled at build time
 * (the phone app has no disk access to read them) and applied to SQLite.
 */
import journal from "../../../packages/db/drizzle/meta/_journal.json";
import type { MigrationFile } from "../../../packages/db/src/sqlite/client";

const files = import.meta.glob("../../../packages/db/drizzle/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export function bundledMigrations(): MigrationFile[] {
  return journal.entries.map((entry) => {
    const key = Object.keys(files).find((path) => path.endsWith(`/${entry.tag}.sql`));
    if (!key) throw new Error(`Migration ${entry.tag} is missing from the phone build`);
    return { tag: entry.tag, sql: files[key]! };
  });
}
