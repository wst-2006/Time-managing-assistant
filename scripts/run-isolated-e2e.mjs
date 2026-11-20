// Runs Playwright against a throwaway embedded database, so tests never touch your real data folder.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
const tempPrefix = join(tmpdir(), "time-managing-assistant-e2e-");
const tempRoot = await mkdtemp(tempPrefix);
const dataDirectory = join(tempRoot, "data");
const corepackScript = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
const playwrightArgs = process.argv.slice(2).filter((argument, index) => argument !== "--" || index > 0);

const healthProfile = {
  sex: "male", age: 20, heightCm: 175, weightKg: 65, activityLevel: "high", goal: "gain_muscle", targetWeightKg: 67,
  exercise: "力量训练每周 4 次，周末骑车", eatingContext: "canteen", likedFoods: ["番茄炒鸡蛋"], avoidFoods: ["海鲜"],
  bodyNotes: "左膝不适", city: null,
};

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${basename(command)} exited with ${signal ?? code}`)));
  });
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
  if (!tempRoot.startsWith(tempPrefix)) throw new Error(`Refusing to remove unexpected E2E path: ${tempRoot}`);
  await rm(tempRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void cleanup().finally(() => process.exit(130)));

try {
  const [apiPort, webPort] = await Promise.all([availablePort(), availablePort()]);
  if (!apiPort || !webPort) throw new Error("Could not reserve isolated E2E ports.");
  const env = {
    ...process.env,
    TMA_DATA_DIR: dataDirectory,
    PLAYWRIGHT_API_PORT: String(apiPort),
    PLAYWRIGHT_WEB_PORT: String(webPort),
    PLAYWRIGHT_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    PLAYWRIGHT_WEB_BASE_URL: `http://127.0.0.1:${webPort}`,
    TMA_E2E_ISOLATED: "1",
    TMA_DISABLE_BACKGROUND_JOBS: "1",
    FEISHU_CALLBACK_TRANSPORT: "http",
  };
  delete env.FEISHU_APP_ID;
  delete env.FEISHU_APP_SECRET;

  console.log("Building the API used by Playwright.");
  await run(process.execPath, [corepackScript, "pnpm", "--filter", "@personal-ai/domain", "--filter", "@personal-ai/db", "--filter", "@personal-ai/worker", "--filter", "@personal-ai/api", "-r", "run", "build"], env);

  console.log(`Seeding a throwaway data folder at ${dataDirectory}.`);
  const { openDatabase } = await import(pathToFileURL(join(workspace, "packages/db/dist/client.js")).href);
  const database = await openDatabase({ dataDir: dataDirectory });
  await database.pglite.query(
    "INSERT INTO health_profiles (id, profile) VALUES ('3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1', $1::jsonb) ON CONFLICT (id) DO NOTHING",
    [JSON.stringify(healthProfile)]
  );
  await database.client.end();

  console.log("Running Playwright.");
  await run(process.execPath, [corepackScript, "pnpm", "--dir", "apps/web", "exec", "playwright", "test", ...playwrightArgs], env);
} finally {
  await cleanup();
}
