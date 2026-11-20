import { config } from "dotenv";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const configuredEnvFile = process.env.PERSONAL_AI_ENV_FILE;
config({
  path: configuredEnvFile ? resolve(configuredEnvFile) : resolve(sourceDirectory, "../../../.env")
});

/**
 * The database is embedded (PGlite) and lives in a plain folder on this
 * computer. `dataDir: null` means an in-memory database (tests only).
 */
export type DatabaseConfig = { dataDir: string | null };

export function defaultDataDirectory(): string {
  return join(homedir(), ".time-managing-assistant", "data");
}

export function loadDatabaseConfig(): DatabaseConfig {
  const configured = process.env.TMA_DATA_DIR?.trim();
  if (configured === ":memory:") return { dataDir: null };
  return { dataDir: configured ? resolve(configured) : defaultDataDirectory() };
}
