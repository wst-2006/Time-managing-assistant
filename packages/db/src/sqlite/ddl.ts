/**
 * Converts the PostgreSQL migrations drizzle-kit writes (packages/db/drizzle)
 * into SQLite table definitions, so the phone keeps the same tables, checks,
 * unique rules and foreign keys as the desktop without a second schema file.
 */
import { maskLiterals, NOW_SQL, rewriteExpressions, unmaskLiterals } from "./translate.js";

const TYPE_MAP: Array<[RegExp, string]> = [
  [/\btimestamp(?:\s*\(\d+\))?\s+with(?:out)?\s+time\s+zone\b/gi, "TEXT"],
  [/\btimestamp(?:\s*\(\d+\))?\b/gi, "TEXT"],
  [/\bcharacter\s+varying(?:\(\d+\))?/gi, "TEXT"],
  [/\bvarchar(?:\(\d+\))?/gi, "TEXT"],
  [/\b(?:uuid|date|jsonb|json|text)\b/gi, "TEXT"],
  [/\bboolean\b/gi, "INTEGER"],
  [/\b(?:integer|smallint|bigint|serial)\b/gi, "INTEGER"],
  [/\b(?:double\s+precision|real|numeric(?:\(\d+(?:,\s*\d+)?\))?)\b/gi, "REAL"]
];

type ForeignKey = { table: string; clause: string };

/** Turns one migration file (statements separated by drizzle's breakpoints) into SQLite statements. */
export function convertMigrationToSqlite(migrationSql: string): string[] {
  const statements = migrationSql.split("--> statement-breakpoint").map((s) => s.trim().replace(/;\s*$/, "")).filter(Boolean);
  const foreignKeys: ForeignKey[] = [];
  const tables = new Map<string, string>();
  const rest: string[] = [];

  for (const statement of statements) {
    const fk = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]+" (FOREIGN KEY [\s\S]+)$/i.exec(statement);
    if (fk) { foreignKeys.push({ table: fk[1]!, clause: fk[2]!.replace(/"public"\./g, "") }); continue; }
    const create = /^CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"/i.exec(statement);
    if (create) { tables.set(create[1]!, statement); continue; }
    rest.push(statement);
  }

  const output: string[] = [];
  for (const [table, statement] of tables) {
    output.push(convertCreateTable(table, statement, foreignKeys.filter((fk) => fk.table === table).map((fk) => fk.clause)));
  }
  for (const fk of foreignKeys) {
    if (!tables.has(fk.table)) throw new Error(`The phone database cannot add a foreign key to the existing table "${fk.table}"; recreate the table in the migration instead`);
  }
  for (const statement of rest) output.push(convertOther(statement));
  return output;
}

function convertCreateTable(table: string, statement: string, foreignKeys: string[]): string {
  const masked = maskLiterals(statement);
  let text = masked.text.replace(new RegExp(`"${table}"\\.`, "g"), "");
  text = protectIdentifiers(text, (body) => {
    let out = body;
    for (const [pattern, replacement] of TYPE_MAP) out = out.replace(pattern, replacement);
    out = out.replace(/\bDEFAULT\s+now\(\)/gi, `DEFAULT (${NOW_SQL})`);
    out = out.replace(/\bDEFAULT\s+true\b/gi, "DEFAULT 1").replace(/\bDEFAULT\s+false\b/gi, "DEFAULT 0");
    out = out.replace(/\bDEFAULT\s+gen_random_uuid\(\)/gi, "DEFAULT (gen_random_uuid())");
    return out;
  });
  text = rewriteExpressions(text, masked.literals);
  if (foreignKeys.length) {
    const close = text.lastIndexOf(")");
    text = `${text.slice(0, close).trimEnd()},\n\t${foreignKeys.join(",\n\t")}\n${text.slice(close)}`;
  }
  return unmaskLiterals(text, masked.literals);
}

function convertOther(statement: string): string {
  const masked = maskLiterals(statement);
  let text = masked.text;
  const index = /^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?"[^"]+" ON "([^"]+)"/i.exec(text);
  if (index) {
    text = text.replace(/\s+USING\s+btree\b/gi, "").replace(new RegExp(`"${index[2]}"\\.`, "g"), "");
    // drizzle-kit writes "col" DESC NULLS LAST etc.; SQLite accepts those.
    return unmaskLiterals(rewriteExpressions(text, masked.literals), masked.literals);
  }
  const addColumn = /^ALTER TABLE "([^"]+)" ADD COLUMN /i.exec(text);
  if (addColumn) {
    text = protectIdentifiers(text, (body) => {
      let out = body;
      for (const [pattern, replacement] of TYPE_MAP) out = out.replace(pattern, replacement);
      out = out.replace(/\bDEFAULT\s+now\(\)/gi, `DEFAULT (${NOW_SQL})`);
      return out.replace(/\bDEFAULT\s+true\b/gi, "DEFAULT 1").replace(/\bDEFAULT\s+false\b/gi, "DEFAULT 0");
    });
    return unmaskLiterals(rewriteExpressions(text, masked.literals), masked.literals);
  }
  // Data changes run through the query translation when applied.
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(text)) return statement;
  if (/^DROP INDEX /i.test(text)) return unmaskLiterals(text.replace(/"public"\./g, ""), masked.literals);
  throw new Error(`The phone database has no conversion for this migration statement yet: ${statement.slice(0, 120)}`);
}

/** Applies `rewrite` to the text outside double-quoted identifiers (so a column named "date" stays). */
function protectIdentifiers(text: string, rewrite: (body: string) => string): string {
  const parts = text.split(/("[^"]*")/);
  return parts.map((part, i) => (i % 2 === 1 ? part : rewrite(part))).join("");
}
