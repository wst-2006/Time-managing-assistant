CREATE TABLE "desktop_command_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"task_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"claimed_by" varchar(128),
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_command_requests_kind_check" CHECK ("desktop_command_requests"."kind" in ('open_task')),
	CONSTRAINT "desktop_command_requests_status_check" CHECK ("desktop_command_requests"."status" in ('pending', 'claimed', 'completed', 'expired')),
	CONSTRAINT "desktop_command_requests_schedule_revision_check" CHECK ("desktop_command_requests"."schedule_revision" > 0),
	CONSTRAINT "desktop_command_requests_claimed_at_check" CHECK (("desktop_command_requests"."status" = 'pending' and "desktop_command_requests"."claimed_at" is null and "desktop_command_requests"."claimed_by" is null) or ("desktop_command_requests"."status" in ('claimed', 'completed') and "desktop_command_requests"."claimed_at" is not null and "desktop_command_requests"."claimed_by" is not null) or ("desktop_command_requests"."status" = 'expired')),
	CONSTRAINT "desktop_command_requests_completed_at_check" CHECK (("desktop_command_requests"."status" = 'completed') = ("desktop_command_requests"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "focus_session_operations" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"focus_session_id" uuid NOT NULL,
	"operation" varchar(32) NOT NULL,
	"expected_version" integer NOT NULL,
	"resulting_version" integer NOT NULL,
	"resulting_state" varchar(32) NOT NULL,
	"result_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_session_operations_operation_check" CHECK ("focus_session_operations"."operation" in ('create', 'begin', 'skip_preparation', 'respond_start', 'other_arrangement', 'end', 'skip_final_break', 'evaluate')),
	CONSTRAINT "focus_session_operations_expected_version_check" CHECK ("focus_session_operations"."expected_version" > 0),
	CONSTRAINT "focus_session_operations_resulting_version_check" CHECK ("focus_session_operations"."resulting_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "focus_session_segment_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"focus_session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"segment_type" varchar(16) NOT NULL,
	"planned_duration_seconds" integer NOT NULL,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"paused_seconds" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_session_segment_runs_position_check" CHECK ("focus_session_segment_runs"."position" >= 0),
	CONSTRAINT "focus_session_segment_runs_type_check" CHECK ("focus_session_segment_runs"."segment_type" in ('focus', 'break')),
	CONSTRAINT "focus_session_segment_runs_duration_check" CHECK ("focus_session_segment_runs"."planned_duration_seconds" > 0),
	CONSTRAINT "focus_session_segment_runs_elapsed_check" CHECK ("focus_session_segment_runs"."elapsed_seconds" >= 0),
	CONSTRAINT "focus_session_segment_runs_paused_seconds_check" CHECK ("focus_session_segment_runs"."paused_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "focus_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"focus_structure_id" uuid,
	"focus_structure_version" integer,
	"focus_structure_schedule_revision" integer,
	"state" varchar(32) NOT NULL,
	"planned_start_at" timestamp with time zone,
	"planned_end_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"preparing_ends_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"active_since_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"current_segment_position" integer,
	"current_segment_started_at" timestamp with time zone,
	"current_segment_elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"paused_total_seconds" integer DEFAULT 0 NOT NULL,
	"confirmation_deadline_at" timestamp with time zone,
	"stopped_reason" text,
	"raw_active_seconds" integer DEFAULT 0 NOT NULL,
	"effective_focus_seconds" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_sessions_state_check" CHECK ("focus_sessions"."state" in ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start', 'running', 'paused', 'ended', 'evaluated', 'stopped_no_response', 'stopped_for_change')),
	CONSTRAINT "focus_sessions_raw_seconds_check" CHECK ("focus_sessions"."raw_active_seconds" >= 0),
	CONSTRAINT "focus_sessions_effective_seconds_check" CHECK ("focus_sessions"."effective_focus_seconds" >= 0),
	CONSTRAINT "focus_sessions_segment_position_check" CHECK ("focus_sessions"."current_segment_position" is null or "focus_sessions"."current_segment_position" >= 0),
	CONSTRAINT "focus_sessions_segment_elapsed_check" CHECK ("focus_sessions"."current_segment_elapsed_seconds" >= 0),
	CONSTRAINT "focus_sessions_paused_total_seconds_check" CHECK ("focus_sessions"."paused_total_seconds" >= 0),
	CONSTRAINT "focus_sessions_structure_version_check" CHECK ("focus_sessions"."focus_structure_version" is null or "focus_sessions"."focus_structure_version" > 0),
	CONSTRAINT "focus_sessions_structure_revision_check" CHECK ("focus_sessions"."focus_structure_schedule_revision" is null or "focus_sessions"."focus_structure_schedule_revision" > 0),
	CONSTRAINT "focus_sessions_planned_interval_check" CHECK ("focus_sessions"."planned_start_at" is null or "focus_sessions"."planned_end_at" is null or "focus_sessions"."planned_end_at" > "focus_sessions"."planned_start_at"),
	CONSTRAINT "focus_sessions_version_check" CHECK ("focus_sessions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "focus_structure_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"focus_structure_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"segment_type" varchar(16) NOT NULL,
	"duration_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_structure_segments_position_check" CHECK ("focus_structure_segments"."position" >= 0),
	CONSTRAINT "focus_structure_segments_type_check" CHECK ("focus_structure_segments"."segment_type" in ('focus', 'break')),
	CONSTRAINT "focus_structure_segments_duration_check" CHECK (("focus_structure_segments"."segment_type" = 'focus' and "focus_structure_segments"."duration_minutes" >= 25) or ("focus_structure_segments"."segment_type" = 'break' and "focus_structure_segments"."duration_minutes" between 5 and 15))
);
--> statement-breakpoint
CREATE TABLE "focus_structures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"task_schedule_revision" integer NOT NULL,
	"state" varchar(20) DEFAULT 'candidate' NOT NULL,
	"source" varchar(16) NOT NULL,
	"mode" varchar(16) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"total_start_at" timestamp with time zone NOT NULL,
	"total_end_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_structures_state_check" CHECK ("focus_structures"."state" in ('candidate', 'active', 'superseded', 'invalidated', 'cancelled')),
	CONSTRAINT "focus_structures_source_check" CHECK ("focus_structures"."source" in ('ai', 'template', 'manual')),
	CONSTRAINT "focus_structures_mode_check" CHECK ("focus_structures"."mode" in ('continuous', 'segmented')),
	CONSTRAINT "focus_structures_revision_check" CHECK ("focus_structures"."task_schedule_revision" > 0),
	CONSTRAINT "focus_structures_version_check" CHECK ("focus_structures"."version" > 0),
	CONSTRAINT "focus_structures_interval_check" CHECK ("focus_structures"."total_end_at" > "focus_structures"."total_start_at")
);
--> statement-breakpoint
CREATE TABLE "focus_timer_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"focus_session_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"expected_session_version" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_timer_jobs_kind_check" CHECK ("focus_timer_jobs"."kind" in ('preparation_start', 'preparation_complete', 'confirmation_timeout', 'segment_transition')),
	CONSTRAINT "focus_timer_jobs_status_check" CHECK ("focus_timer_jobs"."status" in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "focus_timer_jobs_version_check" CHECK ("focus_timer_jobs"."expected_session_version" > 0),
	CONSTRAINT "focus_timer_jobs_attempts_check" CHECK ("focus_timer_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "health_daily_actuals" (
	"local_date" date PRIMARY KEY NOT NULL,
	"protein_grams" integer,
	"fiber_grams" integer,
	"water_milliliters" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_daily_actuals_protein_check" CHECK ("health_daily_actuals"."protein_grams" is null or "health_daily_actuals"."protein_grams" between 0 and 1000),
	CONSTRAINT "health_daily_actuals_fiber_check" CHECK ("health_daily_actuals"."fiber_grams" is null or "health_daily_actuals"."fiber_grams" between 0 and 200),
	CONSTRAINT "health_daily_actuals_water_check" CHECK ("health_daily_actuals"."water_milliliters" is null or "health_daily_actuals"."water_milliliters" between 0 and 10000),
	CONSTRAINT "health_daily_actuals_has_value_check" CHECK ("health_daily_actuals"."protein_grams" is not null or "health_daily_actuals"."fiber_grams" is not null or "health_daily_actuals"."water_milliliters" is not null)
);
--> statement-breakpoint
CREATE TABLE "health_daily_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"health_week_plan_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"day_index" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_daily_references_day_index_check" CHECK ("health_daily_references"."day_index" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "health_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_profiles_version_check" CHECK ("health_profiles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "health_week_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"state" varchar(16) DEFAULT 'candidate' NOT NULL,
	"source" varchar(16) NOT NULL,
	"profile_version" integer NOT NULL,
	"city" varchar(120),
	"solar_term" varchar(32) NOT NULL,
	"special_context" text,
	"based_on_plan_id" uuid,
	"based_on_plan_version" integer,
	"revision_reason" text,
	"overview" text NOT NULL,
	"supplements" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_week_plans_state_check" CHECK ("health_week_plans"."state" in ('candidate', 'active', 'superseded', 'cancelled')),
	CONSTRAINT "health_week_plans_source_check" CHECK ("health_week_plans"."source" in ('template', 'ai', 'manual')),
	CONSTRAINT "health_week_plans_profile_version_check" CHECK ("health_week_plans"."profile_version" > 0),
	CONSTRAINT "health_week_plans_version_check" CHECK ("health_week_plans"."version" > 0),
	CONSTRAINT "health_week_plans_revision_base_check" CHECK (("health_week_plans"."based_on_plan_id" is null and "health_week_plans"."based_on_plan_version" is null) or ("health_week_plans"."based_on_plan_id" is not null and "health_week_plans"."based_on_plan_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "long_range_plan_milestones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"long_range_plan_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"target_date" date,
	"notes" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_range_plan_milestones_position_check" CHECK ("long_range_plan_milestones"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "long_range_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" varchar(16) NOT NULL,
	"title" varchar(200) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"description" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "long_range_plans_scope_check" CHECK ("long_range_plans"."scope" in ('month', 'semester', 'annual')),
	CONSTRAINT "long_range_plans_status_check" CHECK ("long_range_plans"."status" in ('active', 'archived')),
	CONSTRAINT "long_range_plans_period_check" CHECK ("long_range_plans"."period_end" >= "long_range_plans"."period_start"),
	CONSTRAINT "long_range_plans_version_check" CHECK ("long_range_plans"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "reminder_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"channel" varchar(32) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"schedule_revision" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"remote_message_id" varchar(128),
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_jobs_channel_check" CHECK ("reminder_jobs"."channel" in ('feishu')),
	CONSTRAINT "reminder_jobs_kind_check" CHECK ("reminder_jobs"."kind" in ('task_start', 'task_start_ready', 'task_start_lapsed', 'task_start_expire')),
	CONSTRAINT "reminder_jobs_status_check" CHECK ("reminder_jobs"."status" in ('pending', 'processing', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "reminder_jobs_attempts_check" CHECK ("reminder_jobs"."attempts" >= 0),
	CONSTRAINT "reminder_jobs_schedule_revision_check" CHECK ("reminder_jobs"."schedule_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "review_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"review_session_id" uuid NOT NULL,
	"source" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_date" varchar(10) NOT NULL,
	"state" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_sessions_local_date_unique" UNIQUE("local_date")
);
--> statement-breakpoint
CREATE TABLE "task_conflict_acceptances" (
	"task_id_low" uuid NOT NULL,
	"task_schedule_revision_low" integer NOT NULL,
	"task_id_high" uuid NOT NULL,
	"task_schedule_revision_high" integer NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_conflict_acceptances_pk" PRIMARY KEY("task_id_low","task_schedule_revision_low","task_id_high","task_schedule_revision_high"),
	CONSTRAINT "task_conflict_acceptances_order_check" CHECK ("task_conflict_acceptances"."task_id_low" < "task_conflict_acceptances"."task_id_high"),
	CONSTRAINT "task_conflict_acceptances_revisions_check" CHECK ("task_conflict_acceptances"."task_schedule_revision_low" > 0 and "task_conflict_acceptances"."task_schedule_revision_high" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"focus_session_id" uuid,
	"satisfaction" varchar(16) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_feedback_satisfaction_check" CHECK ("task_feedback"."satisfaction" in ('satisfied', 'neutral', 'dissatisfied'))
);
--> statement-breakpoint
CREATE TABLE "task_legacy_metadata" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"planned_effort_minutes" integer,
	"difficulty" varchar(16),
	"task_type" varchar(80),
	"requires_continuous_focus" boolean,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_legacy_metadata_planned_effort_check" CHECK ("task_legacy_metadata"."planned_effort_minutes" is null or ("task_legacy_metadata"."planned_effort_minutes" between 1 and 1440))
);
--> statement-breakpoint
CREATE TABLE "task_lifecycle_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"from_status" varchar(32),
	"to_status" varchar(32) NOT NULL,
	"source" varchar(16) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_lifecycle_events_from_status_check" CHECK ("task_lifecycle_events"."from_status" is null or "task_lifecycle_events"."from_status" in ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled')),
	CONSTRAINT "task_lifecycle_events_to_status_check" CHECK ("task_lifecycle_events"."to_status" in ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled', 'deleted')),
	CONSTRAINT "task_lifecycle_events_source_check" CHECK ("task_lifecycle_events"."source" in ('app', 'ai', 'feishu', 'system'))
);
--> statement-breakpoint
CREATE TABLE "task_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"focus_session_id" uuid,
	"outcome" varchar(32) NOT NULL,
	"progress_percent" integer NOT NULL,
	"source" varchar(16) NOT NULL,
	"note" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_outcomes_value_check" CHECK (("task_outcomes"."outcome" = 'not_completed' and "task_outcomes"."progress_percent" = 0)
        or ("task_outcomes"."outcome" = 'partial' and "task_outcomes"."progress_percent" between 1 and 99)
        or ("task_outcomes"."outcome" = 'complete' and "task_outcomes"."progress_percent" = 100)),
	CONSTRAINT "task_outcomes_source_check" CHECK ("task_outcomes"."source" in ('app', 'ai', 'feishu', 'system'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"source_long_range_plan_id" uuid,
	"record_kind" varchar(16) DEFAULT 'formal' NOT NULL,
	"lifecycle_status" varchar(32) DEFAULT 'open' NOT NULL,
	"schedule_kind" varchar(16) DEFAULT 'none' NOT NULL,
	"current_outcome" varchar(32),
	"local_date" date,
	"daypart" varchar(16),
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"time_zone" varchar(64) DEFAULT 'Asia/Shanghai' NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"schedule_revision" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_lifecycle_status_check" CHECK ("tasks"."lifecycle_status" in ('open', 'active', 'awaiting_outcome', 'closed', 'cancelled')),
	CONSTRAINT "tasks_record_kind_check" CHECK ("tasks"."record_kind" in ('formal', 'backfill')),
	CONSTRAINT "tasks_schedule_kind_check" CHECK ("tasks"."schedule_kind" in ('none', 'daypart', 'exact')),
	CONSTRAINT "tasks_current_outcome_check" CHECK ("tasks"."current_outcome" is null or "tasks"."current_outcome" in ('not_completed', 'partial', 'complete')),
	CONSTRAINT "tasks_time_pair_check" CHECK (("tasks"."start_at" is null and "tasks"."end_at" is null) or ("tasks"."start_at" is not null and "tasks"."end_at" is not null)),
	CONSTRAINT "tasks_exact_minimum_duration_check" CHECK ("tasks"."deleted_at" is not null or "tasks"."end_at" is null or "tasks"."end_at" >= "tasks"."start_at" + interval '30 minutes'),
	CONSTRAINT "tasks_exact_half_hour_boundary_check" CHECK ("tasks"."deleted_at" is not null or "tasks"."start_at" is null or (
        extract(minute from "tasks"."start_at" at time zone "tasks"."time_zone") in (0, 30)
        and extract(second from "tasks"."start_at" at time zone "tasks"."time_zone") = 0
        and extract(minute from "tasks"."end_at" at time zone "tasks"."time_zone") in (0, 30)
        and extract(second from "tasks"."end_at" at time zone "tasks"."time_zone") = 0
      )),
	CONSTRAINT "tasks_schedule_shape_check" CHECK ((
        ("tasks"."schedule_kind" = 'none' and "tasks"."start_at" is null and "tasks"."end_at" is null and "tasks"."daypart" is null)
        or ("tasks"."schedule_kind" = 'daypart' and "tasks"."local_date" is not null and "tasks"."daypart" in ('morning', 'afternoon', 'evening') and "tasks"."start_at" is null and "tasks"."end_at" is null)
        or ("tasks"."schedule_kind" = 'exact' and "tasks"."local_date" is not null and "tasks"."start_at" is not null and "tasks"."end_at" is not null and "tasks"."daypart" is null)
      )),
	CONSTRAINT "tasks_version_check" CHECK ("tasks"."version" > 0),
	CONSTRAINT "tasks_schedule_revision_check" CHECK ("tasks"."schedule_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "unscheduled_task_day_end_runs" (
	"local_date" date PRIMARY KEY NOT NULL,
	"policy" varchar(32) NOT NULL,
	"carried_count" integer DEFAULT 0 NOT NULL,
	"deleted_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unscheduled_task_day_end_runs_policy_check" CHECK ("unscheduled_task_day_end_runs"."policy" in ('carry_forward', 'delete_at_day_end')),
	CONSTRAINT "unscheduled_task_day_end_runs_counts_check" CHECK ("unscheduled_task_day_end_runs"."carried_count" >= 0 and "unscheduled_task_day_end_runs"."deleted_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" integer PRIMARY KEY NOT NULL,
	"personal_context" text DEFAULT '' NOT NULL,
	"ai_guidance" text DEFAULT '' NOT NULL,
	"share_with_ai" boolean DEFAULT true NOT NULL,
	"response_style" varchar(16) DEFAULT 'balanced' NOT NULL,
	"unscheduled_task_policy" varchar(32) DEFAULT 'carry_forward' NOT NULL,
	"recycle_retention_days" integer DEFAULT 3 NOT NULL,
	"focus_flip_sound_enabled" boolean DEFAULT true NOT NULL,
	"focus_start_sound_enabled" boolean DEFAULT true NOT NULL,
	"break_start_sound_enabled" boolean DEFAULT true NOT NULL,
	"break_end_sound_enabled" boolean DEFAULT true NOT NULL,
	"focus_end_sound_enabled" boolean DEFAULT true NOT NULL,
	"focus_theme" varchar(16) DEFAULT 'ink' NOT NULL,
	"desktop_focus_enabled" boolean DEFAULT true NOT NULL,
	"focus_preparation_window_enabled" boolean DEFAULT true NOT NULL,
	"focus_timer_window_enabled" boolean DEFAULT true NOT NULL,
	"focus_evaluation_enabled" boolean DEFAULT true NOT NULL,
	"feishu_task_cards_enabled" boolean DEFAULT true NOT NULL,
	"feishu_t15_enabled" boolean DEFAULT true NOT NULL,
	"health_page_enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_singleton_check" CHECK ("user_profiles"."id" = 1),
	CONSTRAINT "user_profiles_response_style_check" CHECK ("user_profiles"."response_style" in ('concise', 'balanced', 'detailed')),
	CONSTRAINT "user_profiles_unscheduled_task_policy_check" CHECK ("user_profiles"."unscheduled_task_policy" in ('carry_forward', 'delete_at_day_end')),
	CONSTRAINT "user_profiles_recycle_retention_days_check" CHECK ("user_profiles"."recycle_retention_days" between 1 and 30),
	CONSTRAINT "user_profiles_focus_theme_check" CHECK ("user_profiles"."focus_theme" in ('ink', 'flip', 'nixie', 'vapor', 'cyber')),
	CONSTRAINT "user_profiles_version_check" CHECK ("user_profiles"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "desktop_command_requests" ADD CONSTRAINT "desktop_command_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_session_operations" ADD CONSTRAINT "focus_session_operations_focus_session_id_focus_sessions_id_fk" FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_session_segment_runs" ADD CONSTRAINT "focus_session_segment_runs_focus_session_id_focus_sessions_id_fk" FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_focus_structure_id_focus_structures_id_fk" FOREIGN KEY ("focus_structure_id") REFERENCES "public"."focus_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_structure_segments" ADD CONSTRAINT "focus_structure_segments_focus_structure_id_focus_structures_id_fk" FOREIGN KEY ("focus_structure_id") REFERENCES "public"."focus_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_structures" ADD CONSTRAINT "focus_structures_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_timer_jobs" ADD CONSTRAINT "focus_timer_jobs_focus_session_id_focus_sessions_id_fk" FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_daily_references" ADD CONSTRAINT "health_daily_references_health_week_plan_id_health_week_plans_id_fk" FOREIGN KEY ("health_week_plan_id") REFERENCES "public"."health_week_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_week_plans" ADD CONSTRAINT "health_week_plans_based_on_plan_id_health_week_plans_id_fk" FOREIGN KEY ("based_on_plan_id") REFERENCES "public"."health_week_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "long_range_plan_milestones" ADD CONSTRAINT "long_range_plan_milestones_long_range_plan_id_long_range_plans_id_fk" FOREIGN KEY ("long_range_plan_id") REFERENCES "public"."long_range_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_messages" ADD CONSTRAINT "review_messages_review_session_id_review_sessions_id_fk" FOREIGN KEY ("review_session_id") REFERENCES "public"."review_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_conflict_acceptances" ADD CONSTRAINT "task_conflict_acceptances_task_id_low_tasks_id_fk" FOREIGN KEY ("task_id_low") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_conflict_acceptances" ADD CONSTRAINT "task_conflict_acceptances_task_id_high_tasks_id_fk" FOREIGN KEY ("task_id_high") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_feedback" ADD CONSTRAINT "task_feedback_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_feedback" ADD CONSTRAINT "task_feedback_focus_session_id_focus_sessions_id_fk" FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_legacy_metadata" ADD CONSTRAINT "task_legacy_metadata_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_lifecycle_events" ADD CONSTRAINT "task_lifecycle_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outcomes" ADD CONSTRAINT "task_outcomes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outcomes" ADD CONSTRAINT "task_outcomes_focus_session_id_focus_sessions_id_fk" FOREIGN KEY ("focus_session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_long_range_plan_id_long_range_plans_id_fk" FOREIGN KEY ("source_long_range_plan_id") REFERENCES "public"."long_range_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_command_requests_pending_idx" ON "desktop_command_requests" USING btree ("status","expires_at","created_at");--> statement-breakpoint
CREATE INDEX "desktop_command_requests_task_idx" ON "desktop_command_requests" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "focus_session_operations_session_idx" ON "focus_session_operations" USING btree ("focus_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_session_segment_runs_position_unique" ON "focus_session_segment_runs" USING btree ("focus_session_id","position");--> statement-breakpoint
CREATE INDEX "focus_session_segment_runs_session_idx" ON "focus_session_segment_runs" USING btree ("focus_session_id","position");--> statement-breakpoint
CREATE INDEX "focus_sessions_task_id_idx" ON "focus_sessions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "focus_sessions_focus_structure_id_idx" ON "focus_sessions" USING btree ("focus_structure_id");--> statement-breakpoint
CREATE INDEX "focus_sessions_current_idx" ON "focus_sessions" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_sessions_open_task_unique" ON "focus_sessions" USING btree ("task_id") WHERE "focus_sessions"."state" in ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start', 'running', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "focus_structure_segments_position_unique" ON "focus_structure_segments" USING btree ("focus_structure_id","position");--> statement-breakpoint
CREATE INDEX "focus_structure_segments_structure_idx" ON "focus_structure_segments" USING btree ("focus_structure_id","position");--> statement-breakpoint
CREATE INDEX "focus_structures_task_idx" ON "focus_structures" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_structures_active_task_unique" ON "focus_structures" USING btree ("task_id") WHERE "focus_structures"."state" = 'active';--> statement-breakpoint
CREATE INDEX "focus_timer_jobs_due_idx" ON "focus_timer_jobs" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_timer_jobs_open_unique" ON "focus_timer_jobs" USING btree ("focus_session_id","kind") WHERE "focus_timer_jobs"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "health_daily_references_plan_day_unique" ON "health_daily_references" USING btree ("health_week_plan_id","day_index");--> statement-breakpoint
CREATE INDEX "health_daily_references_date_idx" ON "health_daily_references" USING btree ("local_date");--> statement-breakpoint
CREATE INDEX "health_week_plans_week_idx" ON "health_week_plans" USING btree ("week_start","created_at");--> statement-breakpoint
CREATE INDEX "health_week_plans_base_plan_idx" ON "health_week_plans" USING btree ("based_on_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "health_week_plans_active_week_unique" ON "health_week_plans" USING btree ("week_start") WHERE "health_week_plans"."state" = 'active';--> statement-breakpoint
CREATE INDEX "long_range_plan_milestones_plan_idx" ON "long_range_plan_milestones" USING btree ("long_range_plan_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "long_range_plan_milestones_position_unique" ON "long_range_plan_milestones" USING btree ("long_range_plan_id","position");--> statement-breakpoint
CREATE INDEX "long_range_plans_scope_status_idx" ON "long_range_plans" USING btree ("scope","status","period_start");--> statement-breakpoint
CREATE INDEX "reminder_jobs_due_idx" ON "reminder_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_jobs_task_channel_kind_unique" ON "reminder_jobs" USING btree ("task_id","channel","kind");--> statement-breakpoint
CREATE INDEX "review_messages_session_idx" ON "review_messages" USING btree ("review_session_id");--> statement-breakpoint
CREATE INDEX "task_conflict_acceptances_high_idx" ON "task_conflict_acceptances" USING btree ("task_id_high","task_schedule_revision_high");--> statement-breakpoint
CREATE UNIQUE INDEX "task_feedback_focus_session_unique" ON "task_feedback" USING btree ("focus_session_id");--> statement-breakpoint
CREATE INDEX "task_feedback_task_id_idx" ON "task_feedback" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_legacy_metadata_task_unique" ON "task_legacy_metadata" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_lifecycle_events_task_id_idx" ON "task_lifecycle_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_outcomes_task_id_idx" ON "task_outcomes" USING btree ("task_id","recorded_at");--> statement-breakpoint
CREATE INDEX "task_outcomes_focus_session_id_idx" ON "task_outcomes" USING btree ("focus_session_id");--> statement-breakpoint
CREATE INDEX "tasks_local_date_idx" ON "tasks" USING btree ("local_date");--> statement-breakpoint
CREATE INDEX "tasks_exact_interval_idx" ON "tasks" USING btree ("start_at","end_at");--> statement-breakpoint
CREATE INDEX "tasks_record_kind_local_date_idx" ON "tasks" USING btree ("record_kind","local_date");--> statement-breakpoint
CREATE INDEX "tasks_source_long_range_plan_idx" ON "tasks" USING btree ("source_long_range_plan_id");--> statement-breakpoint
INSERT INTO "user_profiles" ("id", "personal_context", "ai_guidance", "share_with_ai", "response_style", "version") VALUES (1, '', '', false, 'balanced', 1) ON CONFLICT ("id") DO NOTHING;
