import type { FastifyInstance } from "fastify";
import type { PGlite } from "@electric-sql/pglite";

// Only the isolated Playwright runner sets this. The embedded database belongs to the API process,
// so browser tests reach it through this route instead of opening the data folder a second time.
const rawTextTypes = [1082, 1083, 1114, 1184, 1186, 1266];

export function registerE2ESqlRoute(app: FastifyInstance, pglite: PGlite) {
  const parsers = Object.fromEntries(rawTextTypes.map((oid) => [oid, (value: string) => value]));
  app.post<{ Body: { sql: string; params?: unknown[]; method?: "all" | "execute" } }>("/__e2e/sql", async (request) => {
    const { sql, params = [], method = "execute" } = request.body;
    const result = await pglite.query(sql, params, { rowMode: method === "all" ? "array" : "object", parsers });
    return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
  });
}
