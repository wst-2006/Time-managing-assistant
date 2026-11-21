/**
 * Applies the same drizzle migrations as the desktop app. Drizzle's own
 * migrator reads the SQL files from disk; the phone app has no disk access,
 * so the files are bundled at build time and handed to the same routine.
 */
import { createHash } from "./node-crypto-shim";
import journal from "../../../packages/db/drizzle/meta/_journal.json";

const files = import.meta.glob("../../../packages/db/drizzle/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export async function migrateInBrowser(db: any): Promise<void> {
  const migrations = journal.entries.map((entry) => {
    const key = Object.keys(files).find((path) => path.endsWith(`/${entry.tag}.sql`));
    if (!key) throw new Error(`Migration ${entry.tag} is missing from the phone build`);
    const query = files[key]!;
    return {
      sql: query.split("--> statement-breakpoint"),
      bps: entry.breakpoints,
      folderMillis: entry.when,
      hash: createHash("sha256").update(query).digest("hex") as string
    };
  });
  await db.dialect.migrate(migrations, db.session, {});
}
