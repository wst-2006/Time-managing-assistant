/**
 * Turns the PostgreSQL statements the app sends (from drizzle and from the
 * hand-written queries in the services and workers) into SQLite statements.
 *
 * The phone app stores its data in SQLite, the database built into Android;
 * the desktop keeps PostgreSQL (PGlite). Rather than keeping two copies of
 * every query, the phone runs the same code and this file rewrites the few
 * PostgreSQL-only constructs the code base uses. Anything new that SQLite
 * cannot run fails loudly in the SQLite end-to-end run instead of on a phone.
 *
 * Timestamps are stored as ISO 8601 UTC text with milliseconds
 * ("2026-11-23T10:00:00.000Z"), so text comparison orders them correctly.
 */

export type SqlValue = string | number | null | Uint8Array;

/** SQLite expression producing the same text as Date.prototype.toISOString(). */
export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const UUID_SQL =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || " +
  "substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

const MARK = "\u0001";

type Masked = { text: string; literals: string[] };

/** Replaces string literals with markers so rewrites never touch text inside quotes. */
export function maskLiterals(sql: string): Masked {
  const literals: string[] = [];
  let text = "";
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { value += "'"; j += 2; continue; }
        if (sql[j] === "'") break;
        value += sql[j];
        j += 1;
      }
      literals.push(value);
      text += `${MARK}${literals.length - 1}${MARK}`;
      i = j;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      text += "\n";
      continue;
    }
    text += ch;
  }
  return { text, literals };
}

export function unmaskLiterals(text: string, literals: string[], mapLiteral: (value: string) => string = (v) => v): string {
  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_, index) => `'${mapLiteral(literals[Number(index)]!).replace(/'/g, "''")}'`);
}

/** Text of the argument list of the call starting at `open` (the index of its "("). */
function balancedEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") { depth -= 1; if (depth === 0) return i; }
  }
  throw new Error(`Unbalanced parentheses in SQL: ${text.slice(open, open + 80)}`);
}

/** Rewrites every call matched by `head` (a regex ending at the call's "("). */
function rewriteCalls(text: string, head: RegExp, replace: (args: string, match: RegExpExecArray) => string): string {
  const pattern = new RegExp(head.source, head.flags.includes("g") ? head.flags : `${head.flags}g`);
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const open = match.index + match[0].length - 1;
    const close = balancedEnd(text, open);
    out += text.slice(last, match.index) + replace(text.slice(open + 1, close), match);
    last = close + 1;
    pattern.lastIndex = last;
  }
  return out + text.slice(last);
}

const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** Brings any timestamp text into the one stored form, so comparisons stay correct. */
export function normalizeTimestampText(value: string): string {
  if (!TIMESTAMP_TEXT.test(value)) return value;
  let text = value.replace(" ", "T");
  if (!/(Z|[+-]\d{2}(:?\d{2})?)$/.test(text)) text += "Z";
  else text = text.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/** Rewrites PostgreSQL-only expressions; shared by queries and table definitions. */
export function rewriteExpressions(text: string, literals: string[]): string {
  let sql = text;
  const literal = (marker: string) => literals[Number(marker.slice(1, -1))]!;

  sql = sql.replace(/"public"\./g, "");
  sql = rewriteCalls(sql, /\bpg_advisory_xact_lock\s*\(/i, () => "1");
  sql = sql.replace(/\bgen_random_uuid\s*\(\s*\)/gi, UUID_SQL);
  sql = sql.replace(/\bnow\s*\(\s*\)/gi, NOW_SQL);
  sql = sql.replace(/\bcurrent_timestamp\b/gi, NOW_SQL);
  // Row locks: SQLite locks the whole database for a write transaction instead.
  sql = sql.replace(/\s+for\s+(?:no\s+key\s+)?(?:update|share)(?:\s+of\s+[\w".]+(?:\s*,\s*[\w".]+)*)?(?:\s+(?:skip\s+locked|nowait))?/gi, "");
  sql = rewriteCalls(sql, /\bcast\s*\(/i, (args) => {
    const m = /^([\s\S]*)\s+as\s+(timestamptz|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|date|text|uuid|jsonb|json|varchar(?:\(\d+\))?)\s*$/i.exec(args);
    return m ? `(${m[1]})` : `CAST(${args})`;
  });
  // timestamp - make_interval(days => n)
  sql = rewriteCalls(sql, /([\w".?$]+|\([^()]*\))\s*-\s*make_interval\s*\(/i, (args, match) => {
    const days = /^\s*days\s*=>\s*([\s\S]+)$/i.exec(args);
    if (!days) throw new Error(`Unsupported make_interval(${args})`);
    return `strftime('%Y-%m-%dT%H:%M:%fZ', ${match[1]}, '-' || (${days[1]}) || ' days')`;
  });
  // timestamp ± interval '30 minutes'
  sql = sql.replace(new RegExp(`([\\w".?$]+)\\s*([+-])\\s*interval\\s+(${MARK}\\d+${MARK})`, "gi"), (_, operand, sign, marker) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', ${operand}, '${sign}${literal(marker)}')`);
  // extract(minute|second from x at time zone tz): the app only uses whole-hour zones.
  sql = sql.replace(new RegExp(`extract\\s*\\(\\s*(minute|second|hour)\\s+from\\s+([\\w".]+)(?:\\s+at\\s+time\\s+zone\\s+(?:[\\w".]+|${MARK}\\d+${MARK}))?\\s*\\)`, "gi"),
    (_, part: string, operand) => part.toLowerCase() === "second" ? `CAST(strftime('%f', ${operand}) AS REAL)` : `CAST(strftime('${part.toLowerCase() === "minute" ? "%M" : "%H"}', ${operand}) AS INTEGER)`);
  // date column + n days
  sql = sql.replace(/\b((?:[\w]+\.)?"?\w*date"?)\s*\+\s*(\d+)\b/gi, (_, column, days) => `date(${column}, '+${days} days')`);
  // jsonb: payload || jsonb_build_object(...)
  sql = rewriteCalls(sql, /([\w".]+)\s*\|\|\s*jsonb_build_object\s*\(/i, (args, match) => `json_patch(${match[1]}, json_object(${args}))`);
  sql = sql.replace(/\bjsonb?_build_object\s*\(/gi, "json_object(");
  sql = sql.replace(/\bgreatest\s*\(/gi, "max(").replace(/\bleast\s*\(/gi, "min(");
  sql = sql.replace(/\bilike\b/gi, "LIKE");
  // Casts: SQLite keeps values as they are stored.
  sql = sql.replace(/::\s*(?:double\s+precision|timestamp(?:\s+with(?:out)?\s+time\s+zone)?|character\s+varying|[a-z_]+)(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?/gi, "");
  return sql;
}

/** Converts one bound value to something SQLite stores the way the app expects to read it back. */
export function toSqliteValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return normalizeTimestampText(value);
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

export type TranslatedStatement = { skip: true } | { skip: false; sql: string; params: SqlValue[] };

/** Column default expressions (already SQLite text) by table and column name. */
export type ColumnDefaults = Map<string, Map<string, string>>;

/** Top-level comma split (outside parentheses). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (text[i] === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** SQLite has no DEFAULT keyword inside VALUES; put each column's own default there instead. */
function replaceDefaultValues(text: string, defaults: ColumnDefaults | undefined): string {
  const head = /^(\s*insert\s+into\s+"([^"]+)"\s*)\(/i.exec(text);
  if (!head || !/\bdefault\b/i.test(text)) return text;
  const columnsOpen = head[0].length - 1;
  const columnsClose = balancedEnd(text, columnsOpen);
  const columns = splitTopLevel(text.slice(columnsOpen + 1, columnsClose)).map((c) => c.trim().replace(/^"|"$/g, ""));
  const tableDefaults = defaults?.get(head[2]!);
  const valuesMatch = /^\s*values\s*/i.exec(text.slice(columnsClose + 1));
  if (!valuesMatch) return text;
  let cursor = columnsClose + 1 + valuesMatch[0].length;
  let out = text.slice(0, cursor);
  while (text[cursor] === "(") {
    const close = balancedEnd(text, cursor);
    const items = splitTopLevel(text.slice(cursor + 1, close)).map((item, i) =>
      /^\s*default\s*$/i.test(item) ? ` ${tableDefaults?.get(columns[i]!) ?? "NULL"}` : item);
    out += `(${items.join(",")})`;
    cursor = close + 1;
    const separator = /^\s*,\s*/.exec(text.slice(cursor));
    if (!separator) break;
    out += separator[0];
    cursor += separator[0].length;
  }
  return out + text.slice(cursor);
}

/** SQLite's RETURNING accepts only bare column names of the changed table ("job.id" → "id"). */
function unqualifyReturning(text: string): string {
  let depth = 0;
  let found = -1;
  const lower = text.toLowerCase();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (depth === 0 && lower.startsWith("returning", i) && /\s/.test(text[i - 1] ?? " ") && /\s/.test(text[i + 9] ?? " ")) found = i;
  }
  if (found === -1) return text;
  const tail = text.slice(found).replace(/(?:"[^"]+"|\b[a-z_][\w]*)\.(?=("[^"]+"|[a-z_*]))/gi, "");
  return text.slice(0, found) + tail;
}

/** Translates one statement and its $n parameters into SQLite text with ? parameters. */
export function translateStatement(sql: string, params: readonly unknown[] = [], defaults?: ColumnDefaults): TranslatedStatement {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  // Isolation levels and similar session settings have no SQLite counterpart.
  if (/^set\s+(transaction|session|local)\b/i.test(trimmed)) return { skip: true };
  const masked = maskLiterals(trimmed);
  const rewritten = unqualifyReturning(rewriteExpressions(replaceDefaultValues(masked.text, defaults), masked.literals));
  const bound: SqlValue[] = [];
  const withPlaceholders = rewritten.replace(/\$(\d+)\b/g, (_, index) => {
    const position = Number(index) - 1;
    if (position < 0 || position >= params.length) throw new Error(`SQL parameter $${index} has no value`);
    bound.push(toSqliteValue(params[position]));
    return "?";
  });
  return { skip: false, sql: unmaskLiterals(withPlaceholders, masked.literals, normalizeTimestampText), params: bound };
}

/** Splits a script into statements at top-level semicolons. */
export function splitStatements(script: string): string[] {
  const masked = maskLiterals(script);
  return masked.text
    .split(";")
    .map((part) => unmaskLiterals(part, masked.literals).trim())
    .filter((part) => part.length > 0);
}
