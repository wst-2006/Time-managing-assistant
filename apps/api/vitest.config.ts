import { defineConfig } from "vitest/config";

// Every test file gets its own throwaway in-memory database.
export default defineConfig({
  test: {
    env: { TMA_DATA_DIR: ":memory:" },
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
});
