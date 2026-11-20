import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), "personal-ai-e2e-"));
const dataDirectory = join(tempRoot, "postgres");
const postgresLog = join(tempRoot, "postgres.log");
const migrationBackupDirectory = join(tempRoot, "migration-backups");
const corepackScript = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
const playwrightArgs = process.argv.slice(2).filter((argument, index) => argument !== "--" || index > 0);
let postgresStarted = false;

const healthProfile = {
  city: null,
  basics: { sex: "male", age: 20, heightCm: 175, weightKg: 65, bodyFatPercent: 16, waistCm: 71.5 },
  goals: ["增肌"],
  stageWeightGoal: { minimumKg: 66, maximumKg: 67 },
  considerations: ["左膝不适"],
  activity: {
    sessionsPerWeek: 5,
    usualDurationMinutes: { minimum: 60, maximum: 120 },
    preferredActivities: ["力量训练", "骑行"],
    avoidHighRisk: true,
  },
  food: {
    mealContext: "食堂或外卖",
    mealTimes: { breakfast: "07:30", lunch: "12:00", dinner: "18:30" },
    dislikes: ["海鲜"],
    commonFoods: ["番茄炒鸡蛋"],
  },
  supplements: { current: ["维生素 D"], considering: ["肌酸"], avoids: ["蛋白粉"] },
  notes: "Isolated E2E profile.",
};

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

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
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

async function stopPostgres() {
  if (!postgresStarted) return;
  await run(commandPath("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { quiet: true })
    .catch(async (error) => {
      const log = await readFile(postgresLog, "utf8").catch(() => "");
      console.error(error.message, log);
    });
  postgresStarted = false;
}

async function cleanup() {
  await stopPostgres();
  const resolvedTemp = join(tmpdir(), "personal-ai-e2e-");
  if (!tempRoot.startsWith(resolvedTemp)) throw new Error(`Refusing to remove unexpected E2E path: ${tempRoot}`);
  await rm(tempRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void cleanup().finally(() => process.exit(130)));
}

try {
  const [databasePort, apiPort, webPort] = await Promise.all([availablePort(), availablePort(), availablePort()]);
  if (!databasePort || !apiPort || !webPort) throw new Error("Could not reserve isolated E2E ports.");

  console.log(`Starting isolated PostgreSQL for E2E on 127.0.0.1:${databasePort}.`);
  await run(commandPath("initdb"), [
    "-D", dataDirectory,
    "-U", "personal_ai_app",
    "--auth=trust",
    "--encoding=UTF8",
    "--locale=C",
  ], { quiet: true });
  await run(commandPath("pg_ctl"), [
    "-D", dataDirectory,
    "-l", postgresLog,
    "-o", `-h 127.0.0.1 -p ${databasePort}`,
    "-w", "start",
  ], { quiet: true });
  postgresStarted = true;
  await run(commandPath("createdb"), [
    "-h", "127.0.0.1",
    "-p", String(databasePort),
    "-U", "personal_ai_app",
    "personal_ai_assistant",
  ], { quiet: true });

  const isolatedEnv = {
    ...process.env,
    DATABASE_URL: `postgresql://personal_ai_app@127.0.0.1:${databasePort}/personal_ai_assistant`,
    EXPECTED_DB_HOST: "127.0.0.1",
    EXPECTED_DB_PORT: String(databasePort),
    EXPECTED_DB_NAME: "personal_ai_assistant",
    EXPECTED_DB_USER: "personal_ai_app",
    EXPECTED_PG_MAJOR: "18",
    PERSONAL_AI_MIGRATION_BACKUP_DIR: migrationBackupDirectory,
    PLAYWRIGHT_API_PORT: String(apiPort),
    PLAYWRIGHT_WEB_PORT: String(webPort),
    PLAYWRIGHT_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    PLAYWRIGHT_WEB_BASE_URL: `http://127.0.0.1:${webPort}`,
    PERSONAL_AI_E2E_ISOLATED: "1",
    FEISHU_CALLBACK_TRANSPORT: "http",
  };

  console.log("Applying guarded migrations to the isolated E2E database.");
  await run(process.execPath, [corepackScript, "pnpm", "--filter", "@personal-ai/db", "migrate"], { env: isolatedEnv });
  console.log("Verifying and seeding deterministic isolated E2E prerequisites.");
  await run(process.execPath, [corepackScript, "pnpm", "db:verify"], { env: isolatedEnv });
  await run(commandPath("psql"), [
    "-h", "127.0.0.1",
    "-p", String(databasePort),
    "-U", "personal_ai_app",
    "-d", "personal_ai_assistant",
    "-v", "ON_ERROR_STOP=1",
    "-c", [
      "INSERT INTO user_profiles (id) VALUES (1) ON CONFLICT (id) DO NOTHING;",
      `INSERT INTO health_profiles (id, profile) VALUES ('3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1', ${sqlLiteral(JSON.stringify(healthProfile))}::jsonb) ON CONFLICT (id) DO NOTHING;`,
    ].join(" "),
  ], { env: isolatedEnv, quiet: true });
  console.log("Building the API used by Playwright.");
  await run(process.execPath, [corepackScript, "pnpm", "--filter", "@personal-ai/api", "build"], { env: isolatedEnv });
  console.log("Running Playwright against the isolated E2E database.");
  await run(process.execPath, [
    corepackScript, "pnpm", "--dir", "apps/web", "exec", "playwright", "test", ...playwrightArgs,
  ], { env: isolatedEnv });
} finally {
  await cleanup();
}
