CREATE TABLE "conversation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cook_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"build" text NOT NULL,
	"path" text NOT NULL,
	"screen" text NOT NULL,
	"queue_id" uuid,
	"recipe_name" text NOT NULL,
	"step_key" text,
	"chapter_id" text,
	"plan_version" integer,
	"plan" jsonb,
	"state" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"dom" text NOT NULL,
	"dom_truncated" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"note_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cook_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "doc_recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"ingredients" jsonb,
	"steps" jsonb,
	"estimated_time" jsonb,
	"serves" integer,
	"tags" jsonb,
	"notes" text,
	"step_ingredients" jsonb,
	"raw_doc_text" text NOT NULL,
	"extraction_error" text,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	"serves_estimate" integer,
	"serves_estimate_basis" text,
	"doc_position" integer,
	"category_title" text,
	"serves_estimate_source_hash" text,
	"cook_plan" jsonb,
	"cook_plan_error" text,
	"cook_plan_source_hash" text,
	"cook_plan_stamp" text,
	CONSTRAINT "doc_recipes_doc_slug_unique" UNIQUE("doc_slug"),
	CONSTRAINT "doc_recipes_serves_estimate_positive" CHECK ("doc_recipes"."serves_estimate" > 0),
	CONSTRAINT "doc_recipes_serves_estimate_basis_paired" CHECK (("doc_recipes"."serves_estimate" is null) = ("doc_recipes"."serves_estimate_basis" is null)),
	CONSTRAINT "doc_recipes_serves_estimate_hash_paired" CHECK (("doc_recipes"."serves_estimate" is null) = ("doc_recipes"."serves_estimate_source_hash" is null)),
	CONSTRAINT "doc_recipes_cook_plan_or_error" CHECK ("doc_recipes"."cook_plan" is null or "doc_recipes"."cook_plan_error" is null)
);
--> statement-breakpoint
ALTER TABLE "doc_recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kitchen_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_notion_id" text,
	"recipe_data" jsonb,
	"target_user" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"cook_plan" jsonb,
	"cook_plan_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cook_log" jsonb,
	"cook_log_error" text,
	"cook_log_claimed_at" timestamp with time zone,
	"rating_closed_at" timestamp with time zone,
	"serves_estimate" integer,
	"serves_estimate_basis" text,
	"serves_estimate_source_hash" text,
	"intake_recipe" jsonb,
	"intake_error" text,
	"intake_source_hash" text,
	"intake_stamp" text,
	"intake_attempts" integer,
	"intake_nudges" jsonb,
	"finished_by" text,
	"last_screen_active_at" timestamp with time zone,
	"last_interaction_at" timestamp with time zone,
	CONSTRAINT "kitchen_queue_serves_estimate_positive" CHECK ("kitchen_queue"."serves_estimate" > 0),
	CONSTRAINT "kitchen_queue_serves_estimate_basis_paired" CHECK (("kitchen_queue"."serves_estimate" is null) = ("kitchen_queue"."serves_estimate_basis" is null)),
	CONSTRAINT "kitchen_queue_serves_estimate_hash_paired" CHECK (("kitchen_queue"."serves_estimate" is null) = ("kitchen_queue"."serves_estimate_source_hash" is null)),
	CONSTRAINT "kitchen_queue_intake_recipe_or_error" CHECK ("kitchen_queue"."intake_recipe" is null or "kitchen_queue"."intake_error" is null),
	CONSTRAINT "kitchen_queue_finished_by_known" CHECK ("kitchen_queue"."finished_by" in ('pressed', 'auto'))
);
--> statement-breakpoint
ALTER TABLE "kitchen_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recipe_ideas_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipe_ideas_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "cook_reports_created_at_idx" ON "cook_reports" USING btree ("created_at" DESC NULLS LAST);