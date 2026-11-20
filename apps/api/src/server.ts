import { openDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { startBackgroundJobs } from "@personal-ai/worker/loops";
import { buildApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { PostgresTaskStore } from "./task-repository.js";
import { TaskService } from "./task-service.js";
import { FocusService } from "./focus-service.js";
import { FocusStructureService } from "./focus-structure-service.js";
import { ReviewService } from "./review-service.js";
import { GrowthService } from "./growth-service.js";
import { FeishuWebhookService, loadFeishuWebhookConfig } from "./feishu-webhook.js";
import { BackupService } from "./backup-service.js";
import { HealthService } from "./health-service.js";
import { LongRangePlanService } from "./long-range-plan-service.js";
import { UserProfileService } from "./user-profile-service.js";
import { FeishuCardActionService, loadFeishuCardActionConfig } from "./feishu-card-actions.js";
import { FeishuLongConnectionService, loadFeishuLongConnectionConfig } from "./feishu-long-connection.js";
import { DesktopCommandService } from "./desktop-command-service.js";

const config = loadServerConfig();
const databaseConfig = loadDatabaseConfig();
// The embedded database opens (and migrates) here; nothing has to be installed.
const database = await openDatabase(databaseConfig);
const taskService = new TaskService(new PostgresTaskStore(database.db));
const focusService = new FocusService(database.db);

// Feishu is optional: everything below stays null unless its settings are filled in.
const feishuActionConfig = loadFeishuCardActionConfig(process.env);
const feishuWebhookConfig = loadFeishuWebhookConfig(process.env);
const feishuLongConnectionConfig = loadFeishuLongConnectionConfig(process.env);
const feishuActions = feishuActionConfig ? new FeishuCardActionService(feishuActionConfig, taskService, focusService) : null;
const feishuLongConnection = feishuActions && feishuLongConnectionConfig
  ? new FeishuLongConnectionService(feishuLongConnectionConfig, feishuActions)
  : null;

const app = buildApp({
  taskService,
  focusService,
  focusStructureService: new FocusStructureService(database.db),
  reviewService: new ReviewService(database.db),
  growthService: new GrowthService(database.db),
  backupService: new BackupService(database.db),
  healthService: new HealthService(database.db),
  longRangePlanService: new LongRangePlanService(database.db),
  userProfileService: new UserProfileService(database.db),
  desktopCommandService: new DesktopCommandService(database.db),
  feishuWebhookService: feishuActions && feishuWebhookConfig ? new FeishuWebhookService(feishuWebhookConfig, feishuActions) : undefined
});

const backgroundJobs = startBackgroundJobs(database.db, process.env, { warn: (message) => app.log.warn(message), error: (message, error) => app.log.error({ err: error }, String(message)) });

app.addHook("onClose", async () => {
  await backgroundJobs.stop();
  await feishuLongConnection?.stop();
  await database.client.end();
});

async function shutdown() {
  try { await app.close(); } finally { process.exit(0); }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(`Data folder: ${databaseConfig.dataDir ?? "memory"}`);
  if (feishuLongConnection) await feishuLongConnection.start();
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
