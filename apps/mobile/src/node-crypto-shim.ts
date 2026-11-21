/**
 * The two pieces of `node:crypto` the shared API code uses, rebuilt on web
 * APIs so the same services can run inside the phone app.
 */
import { sha256 } from "@noble/hashes/sha2";

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createHash(algorithm: string) {
  if (algorithm !== "sha256") throw new Error(`Unsupported hash in the phone app: ${algorithm}`);
  const chunks: Uint8Array[] = [];
  const hash = {
    update(data: string | Uint8Array) {
      chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return hash;
    },
    digest(encoding?: "hex"): any {
      const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) { total.set(chunk, offset); offset += chunk.length; }
      const digest = sha256(total);
      return encoding === "hex" ? toHex(digest) : digest;
    }
  };
  return hash;
}

export function timingSafeEqual(): boolean {
  throw new Error("timingSafeEqual is not available in the phone app");
}

export function createDecipheriv(): never {
  throw new Error("createDecipheriv is not available in the phone app");
}
