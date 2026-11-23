/**
 * Newer browser functions the app uses, added for phones whose Android System
 * WebView is older (found on a WebView 91 emulator: crypto.randomUUID arrived
 * in 92, Array.prototype.at in 92). Each one is only added when missing.
 */
const g = globalThis as any;

if (g.crypto && typeof g.crypto.randomUUID !== "function") {
  g.crypto.randomUUID = function randomUUID(): string {
    const bytes = g.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

function defineAt(proto: any) {
  if (typeof proto.at === "function") return;
  Object.defineProperty(proto, "at", {
    configurable: true,
    writable: true,
    value(this: { length: number; [index: number]: unknown }, index: number) {
      const n = Math.trunc(index) || 0;
      const i = n < 0 ? this.length + n : n;
      return i < 0 || i >= this.length ? undefined : (typeof this === "string" ? (this as string).charAt(i) : this[i]);
    }
  });
}
defineAt(Array.prototype);
defineAt(String.prototype);
for (const typed of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) defineAt(typed.prototype);

if (typeof (Object as any).hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", { configurable: true, writable: true, value: (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key) });
}

if (typeof (Array.prototype as any).findLast !== "function") {
  Object.defineProperty(Array.prototype, "findLast", { configurable: true, writable: true, value(this: unknown[], test: (v: unknown, i: number, a: unknown[]) => boolean) { for (let i = this.length - 1; i >= 0; i -= 1) if (test(this[i], i, this)) return this[i]; return undefined; } });
  Object.defineProperty(Array.prototype, "findLastIndex", { configurable: true, writable: true, value(this: unknown[], test: (v: unknown, i: number, a: unknown[]) => boolean) { for (let i = this.length - 1; i >= 0; i -= 1) if (test(this[i], i, this)) return i; return -1; } });
}

if (typeof g.structuredClone !== "function") {
  g.structuredClone = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value), (_key, v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? new Date(v) : v);
}

export {};
