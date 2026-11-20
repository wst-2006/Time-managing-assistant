import cors from "@fastify/cors";
import Fastify, { LogController } from "fastify";
import { taskRoutes } from "./task-routes.js";
import type { TaskService } from "./task-service.js";
import { focusRoutes } from "./focus-routes.js";
import type { FocusService } from "./focus-service.js";
import { focusStructureRoutes } from "./focus-structure-routes.js";
import type { FocusStructureService } from "./focus-structure-service.js";
import { reviewRoutes } from "./review-routes.js";
import type { ReviewService } from "./review-service.js";
import { growthRoutes } from "./growth-routes.js";
import type { GrowthService } from "./growth-service.js";
import { feishuRoutes } from "./feishu-routes.js";
import type { FeishuWebhookService } from "./feishu-webhook.js";
import { backupRoutes } from "./backup-routes.js";
import type { BackupExporter } from "./backup-service.js";
import { healthRoutes } from "./health-routes.js";
import type { HealthService } from "./health-service.js";
import { longRangePlanRoutes } from "./long-range-plan-routes.js";
import type { LongRangePlanService } from "./long-range-plan-service.js";
import { userProfileRoutes } from "./user-profile-routes.js";
import type { UserProfileService } from "./user-profile-service.js";
import { desktopCommandRoutes } from "./desktop-command-routes.js";
import type { DesktopCommandService } from "./desktop-command-service.js";

declare module "fastify" {
  interface FastifyRequest { rawBody?: string }
}

type AppOptions = {
  taskService?: TaskService;
  focusService?: FocusService;
  focusStructureService?: FocusStructureService;
  reviewService?: ReviewService;
  growthService?: GrowthService;
  feishuWebhookService?: FeishuWebhookService;
  backupService?: BackupExporter;
  healthService?: HealthService;
  longRangePlanService?: LongRangePlanService;
  userProfileService?: UserProfileService;
  desktopCommandService?: DesktopCommandService;
};

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: true,
    logController: new LogController({
      disableRequestLogging: process.env.NODE_ENV === "production"
    }),
    bodyLimit: 9 * 1024 * 1024
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = String(body);
    request.rawBody = rawBody;
    try { done(null, rawBody ? JSON.parse(rawBody) : null); }
    catch (error) { done(error as Error); }
  });

  app.register(cors, {
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://tauri.localhost",
      "https://tauri.localhost",
      ...(process.env.PLAYWRIGHT_WEB_BASE_URL ? [process.env.PLAYWRIGHT_WEB_BASE_URL] : [])
    ]
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "time-managing-assistant-api"
  }));

  if (options.taskService) {
    app.register(taskRoutes, {
      prefix: "/api/v1",
      taskService: options.taskService
    });
  }

  if (options.focusService) app.register(focusRoutes, { prefix: "/api/v1", focusService: options.focusService });
  if (options.focusStructureService) app.register(focusStructureRoutes, { prefix: "/api/v1", focusStructureService: options.focusStructureService });
  if (options.reviewService) app.register(reviewRoutes, { prefix: "/api/v1", reviewService: options.reviewService });
  if (options.growthService) app.register(growthRoutes, { prefix: "/api/v1", growthService: options.growthService });
  if (options.feishuWebhookService) app.register(feishuRoutes, { prefix: "/api/v1", webhookService: options.feishuWebhookService });
  if (options.backupService) app.register(backupRoutes, { prefix: "/api/v1", backupService: options.backupService });
  if (options.healthService) app.register(healthRoutes, { prefix: "/api/v1", healthService: options.healthService });
  if (options.longRangePlanService) app.register(longRangePlanRoutes, { prefix: "/api/v1", longRangePlanService: options.longRangePlanService });
  if (options.userProfileService) app.register(userProfileRoutes, { prefix: "/api/v1", userProfileService: options.userProfileService });
  if (options.desktopCommandService) app.register(desktopCommandRoutes, { prefix: "/api/v1", desktopCommandService: options.desktopCommandService });

  return app;
}
