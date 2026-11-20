import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), "personal-ai-api-test-"));
const dataDirectory = join(tempRoot, "postgres");
const migrationBackupDirectory = join(tempRoot, "migration-backups");
const corepackScript = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
const testArgs = process.argv.slice(2).filter((argument, index) => argument !== "--" || index > 0);
let postgresStarted = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: options.env ?? process.env,
      stdio: options.quiet ? "pipe" : "inherit",
      windowsHide: true,
    });
    let stderr = "";
    if (options.quiet) child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${basename(command)} exited with ${signal ?? code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function commandPath(name) {
  const configured = process.env.POSTGRES_BIN?.trim();
  if (configured) return join(configured, process.platform === "win32" ? `${name}.exe` : name);
  if (process.platform === "win32") return join("C:\\Program Files\\PostgreSQL\\18\\bin", `${name}.exe`);
  return name;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function cleanup() {
  if (postgresStarted) {
    await run(commandPath("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { quiet: true }).catch(() => undefined);
    postgresStarted = false;
  }
  const permittedPrefix = join(tmpdir(), "personal-ai-api-test-");
  if (!tempRoot.startsWith(permittedPrefix)) throw new Error(`Refusing to remove unexpected test path: ${tempRoot}`);
  await rm(tempRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void cleanup().finally(() => process.exit(130)));
}

try {
  const databasePort = await availablePort();
  if (!databasePort) throw new Error("Could not reserve an isolated PostgreSQL port.");
  const isolatedEnv = {
    ...process.env,
    DATABASE_URL: `postgresql://personal_ai_app@127.0.0.1:${databasePort}/personal_ai_assistant`,
    EXPECTED_DB_HOST: "127.0.0.1",
    EXPECTED_DB_PORT: String(databasePort),
    EXPECTED_DB_NAME: "personal_ai_assistant",
    EXPECTED_DB_USER: "personal_ai_app",
    EXPECTED_PG_MAJOR: "18",
    PERSONAL_AI_MIGRATION_BACKUP_DIR: migrationBackupDirectory,
  };

  console.log(`Starting isolated PostgreSQL for API tests on 127.0.0.1:${databasePort}.`);
  await run(commandPath("initdb"), ["-D", dataDirectory, "-U", "personal_ai_app", "--auth=trust", "--encoding=UTF8", "--locale=C"], { quiet: true });
  await run(commandPath("pg_ctl"), ["-D", dataDirectory, "-o", `-h 127.0.0.1 -p ${databasePort}`, "-w", "start"], { quiet: true });
  postgresStarted = true;
  await run(commandPath("createdb"), ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "personal_ai_app", "personal_ai_assistant"], { quiet: true });
  await run(process.execPath, [corepackScript, "pnpm", "--filter", "@personal-ai/db", "migrate"], { env: isolatedEnv });
  await run(process.execPath, [corepackScript, "pnpm", "db:verify"], { env: isolatedEnv });
  await run(commandPath("psql"), [
    "-h", "127.0.0.1", "-p", String(databasePort), "-U", "personal_ai_app", "-d", "personal_ai_assistant",
    "-v", "ON_ERROR_STOP=1", "-c", "INSERT INTO user_profiles (id) VALUES (1) ON CONFLICT (id) DO NOTHING;",
  ], { env: isolatedEnv, quiet: true });
  const healthProfile = JSON.stringify({
    city: null,
    basics: { sex: "male", age: 20, heightCm: 175, weightKg: 65, bodyFatPercent: 16, waistCm: 71.5 },
    goals: ["增肌"],
    stageWeightGoal: { minimumKg: 66, maximumKg: 67 },
    considerations: ["左膝不适"],
    activity: { sessionsPerWeek: 5, usualDurationMinutes: { minimum: 60, maximum: 120 }, preferredActivities: ["力量训练", "骑行"], avoidHighRisk: true },
    food: { mealContext: "食堂或外卖", mealTimes: { breakfast: "07:30", lunch: "12:00", dinner: "18:30" }, dislikes: ["海鲜"], commonFoods: ["番茄炒鸡蛋"] },
    supplements: { current: ["维生素 D"], considering: ["肌酸"], avoids: ["蛋白粉"] },
    notes: "Isolated API test profile.",
  }).replaceAll("'", "''");
  await run(commandPath("psql"), [
    "-h", "127.0.0.1", "-p", String(databasePort), "-U", "personal_ai_app", "-d", "personal_ai_assistant",
    "-v", "ON_ERROR_STOP=1", "-c", `INSERT INTO health_profiles (id, profile) VALUES ('3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1', '${healthProfile}'::jsonb) ON CONFLICT (id) DO NOTHING;`,
  ], { env: isolatedEnv, quiet: true });
  await run(process.execPath, [corepackScript, "pnpm", "--filter", "@personal-ai/api", "test", "--", ...testArgs], { env: isolatedEnv });
} finally {
  await cleanup();
}
