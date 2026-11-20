import type { FastifyInstance } from "fastify";
import { createManualHealthPlanCandidateSchema, healthPlanConfirmationSchema, healthWeekStartSchema, saveHealthDailyActualSchema, saveHealthProfileSchema, updateManualHealthPlanCandidateSchema } from "@personal-ai/domain/health";
import { reviewDateSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import {
  HealthPlanNotFoundError,
  HealthActivePlanRequiredError,
  HealthPlanBaseChangedError,
  HealthPlanStateError,
  HealthPlanVersionConflictError,
  HealthProfileNotFoundError,
  HealthProfileVersionConflictError,
  HealthService
} from "./health-service.js";

const planIdParams = z.object({ id: z.string().uuid() });
const weekParams = z.object({ weekStart: healthWeekStartSchema });
const dayParams = z.object({ localDate: reviewDateSchema });
const sundayOpenInput = z.object({ localDate: reviewDateSchema }).strict();

export async function healthRoutes(app: FastifyInstance, options: { healthService: HealthService }) {
  const { healthService } = options;

  app.get("/health/profile", async () => ({ profile: serializeProfile(await healthService.getProfile()) }));

  app.put("/health/profile", async (request, reply) => {
    const input = saveHealthProfileSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_health_profile", details: input.error.flatten() });
    try {
      return reply.status(200).send({ profile: serializeProfile(await healthService.saveProfile(input.data.profile, input.data.expectedVersion)) });
    } catch (error) {
      return healthError(reply, error);
    }
  });

  app.get("/health/weeks/:weekStart", async (request, reply) => {
    const params = weekParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_health_week" });
    const week = await healthService.getWeek(params.data.weekStart);
    return { active: serializePlan(week.active), candidate: serializePlan(week.candidate) };
  });

  app.post("/health/weeks/sunday-open", async (request, reply) => {
    const input = sundayOpenInput.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_health_sunday_open" });
    return { status: "explicit_generation_required", plan: null };
  });

  app.get("/health/days/:localDate", async (request, reply) => {
    const params = dayParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_health_reference_date" });
    const reference = await healthService.getDay(params.data.localDate);
    return { reference: reference ? { plan: reference.plan, day: { ...reference.day, content: reference.day.content } } : null };
  });

  app.get("/health/days/:localDate/actual", async (request, reply) => {
    const params = dayParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_health_actual_date" });
    return { actual: await healthService.getDailyActual(params.data.localDate) };
  });

  app.put("/health/days/:localDate/actual", async (request, reply) => {
    const params = dayParams.safeParse(request.params);
    const input = saveHealthDailyActualSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_health_daily_actual" });
    return { actual: await healthService.saveDailyActual(params.data.localDate, input.data) };
  });

  app.post("/health/weeks/manual-candidates", async (request, reply) => {
    const input = createManualHealthPlanCandidateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_manual_health_candidate", details: input.error.flatten() });
    try {
      return reply.status(201).send({ plan: serializePlan(await healthService.createManualCandidate(input.data)) });
    } catch (error) {
      return healthError(reply, error);
    }
  });

  app.put("/health/weeks/:id/manual-candidate", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const input = updateManualHealthPlanCandidateSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_manual_health_candidate_update" });
    try {
      return reply.status(200).send({ plan: serializePlan(await healthService.updateManualCandidate(params.data.id, input.data)) });
    } catch (error) {
      return healthError(reply, error);
    }
  });

  app.post("/health/weeks/:id/confirm", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const input = healthPlanConfirmationSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_health_plan_confirmation" });
    try {
      return { plan: serializePlan(await healthService.confirm(params.data.id, input.data.expectedVersion)) };
    } catch (error) {
      return healthError(reply, error);
    }
  });

  app.post("/health/weeks/:id/cancel", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const input = healthPlanConfirmationSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_health_plan_cancellation" });
    try {
      return { plan: serializePlan(await healthService.cancel(params.data.id, input.data.expectedVersion)) };
    } catch (error) {
      return healthError(reply, error);
    }
  });
}

function serializeProfile(profile: Awaited<ReturnType<HealthService["getProfile"]>>) {
  return profile ? { ...profile, profile: profile.profile } : null;
}

function serializePlan(plan: Awaited<ReturnType<HealthService["getWeek"]>>["active"] | null) {
  return plan ? { ...plan.plan, days: plan.days.map((day) => ({ ...day, content: day.content })) } : null;
}

function healthError(reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof HealthProfileNotFoundError) return reply.status(409).send({ error: "health_profile_required" });
  if (error instanceof HealthProfileVersionConflictError) return reply.status(409).send({ error: "health_profile_version_conflict", profile: serializeProfile(error.current) });
  if (error instanceof HealthPlanNotFoundError) return reply.status(404).send({ error: "health_plan_not_found" });
  if (error instanceof HealthActivePlanRequiredError) return reply.status(409).send({ error: "health_active_plan_required" });
  if (error instanceof HealthPlanBaseChangedError) return reply.status(409).send({ error: "health_plan_base_changed", active: serializePlan(error.current) });
  if (error instanceof HealthPlanVersionConflictError) return reply.status(409).send({ error: "health_plan_version_conflict", plan: serializePlan(error.current) });
  if (error instanceof HealthPlanStateError) return reply.status(409).send({ error: "invalid_health_plan_transition", state: error.state, operation: error.operation });
  throw error;
}
