import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The embedded database runs one transaction at a time. A query on `this.db`
 * made inside `this.db.transaction(...)` waits for the transaction, which waits
 * for the query: the request never returns and every later request queues
 * behind it until the app restarts. (This froze the 准备 window after
 * 「我会准时开始」.) Code inside a transaction must use the transaction object.
 */
const folders = [resolve(import.meta.dirname), resolve(import.meta.dirname, "../../worker/src")];

function transactionBodies(source: string) {
  const bodies: Array<{ body: string; offset: number }> = [];
  const opener = /\b(?:this\.)?db\.transaction\(\s*async\s*\(\s*\w+[^)]*\)\s*=>\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    bodies.push({ body: source.slice(match.index + match[0].length, index), offset: match.index + match[0].length });
  }
  return bodies;
}

/** Method name → body, for methods declared as `name(...) {` or `async name(...) {` in a class. */
function methodBodies(source: string) {
  const methods = new Map<string, string>();
  const header = /^\s*(?:private\s+|public\s+|protected\s+)?(?:async\s+)?(\w+)\s*\([^;{]*?\)\s*(?::[^{;=]+)?\{/gm;
  let match: RegExpExecArray | null;
  while ((match = header.exec(source))) {
    if (["if", "for", "while", "switch", "catch", "function"].includes(match[1]!)) continue;
    let depth = 1;
    let index = match.index + match[0].length;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    methods.set(match[1]!, source.slice(match.index + match[0].length, index));
  }
  return methods;
}

describe("transactions", () => {
  it("never query this.db while a transaction is open, directly or through a helper", () => {
    const offenders: string[] = [];
    for (const folder of folders) {
      for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
        const source = readFileSync(resolve(folder, file), "utf8");
        const methods = methodBodies(source);
        // Methods that reach this.db themselves or through other methods of the same file.
        const touching = new Set([...methods].filter(([, body]) => /this\.db\b(?!\s*\.transaction)/.test(body)).map(([name]) => name));
        for (let changed = true; changed;) {
          changed = false;
          for (const [name, body] of methods) {
            if (touching.has(name)) continue;
            if ([...body.matchAll(/this\.(\w+)\(/g)].some((call) => touching.has(call[1]!))) { touching.add(name); changed = true; }
          }
        }
        for (const { body, offset } of transactionBodies(source)) {
          for (const use of body.matchAll(/this\.db\b(?!\s*\.transaction)|this\.(\w+)\(/g)) {
            if (use[1] && !touching.has(use[1])) continue;
            const line = source.slice(0, offset + (use.index ?? 0)).split("\n").length;
            offenders.push(`${file}:${line} ${use[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
