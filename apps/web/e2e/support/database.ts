import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "@personal-ai/db/schema";
import type { AppDatabase } from "@personal-ai/db/client";

const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? "3100"}`;

/**
 * Drizzle client for E2E checks. The API process owns the embedded database, so queries are
 * forwarded to its test-only SQL route. Transactions run their statements in order without
 * atomicity, which is enough for setting up and cleaning test rows.
 */
export async function connectE2EDatabase() {
  const db = drizzle(async (sql, params, method) => {
    const response = await fetch(`${apiBaseUrl}/__e2e/sql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, params, method })
    });
    if (!response.ok) throw new Error(`E2E SQL failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { rows: unknown[]; affectedRows: number };
    // Match the PGlite driver: db.execute() and writes without RETURNING resolve to { rows, affectedRows }.
    return { rows: (method === "execute" ? { rows: body.rows, affectedRows: body.affectedRows } : body.rows) as never[] };
  }, { schema });
  const shaped = db as unknown as AppDatabase;
  (shaped as unknown as { transaction: (work: (transaction: AppDatabase) => Promise<unknown>) => Promise<unknown> }).transaction = async (work) => work(shaped);
  return { db: shaped, client: { end: async () => undefined } };
}
