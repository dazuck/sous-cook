CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"member_id" uuid,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"reserved_micros" bigint NOT NULL,
	"cost_micros" bigint,
	"input_tokens" integer,
	"output_tokens" integer,
	"search_queries" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_usage_feature_known" CHECK ("ai_usage"."feature" in ('ask', 'import-url', 'import-text', 'import-photo', 'serves-estimate', 'cook-plan', 'intake', 'grocery-parse', 'pantry-reconcile', 'library-refresh')),
	CONSTRAINT "ai_usage_provider_known" CHECK ("ai_usage"."provider" in ('google', 'anthropic')),
	CONSTRAINT "ai_usage_status_known" CHECK ("ai_usage"."status" in ('reserved', 'settled', 'failed')),
	CONSTRAINT "ai_usage_reserved_nonnegative" CHECK ("ai_usage"."reserved_micros" >= 0),
	CONSTRAINT "ai_usage_cost_nonnegative" CHECK ("ai_usage"."cost_micros" is null or "ai_usage"."cost_micros" >= 0),
	CONSTRAINT "ai_usage_settled_has_time" CHECK (("ai_usage"."status" = 'reserved') = ("ai_usage"."settled_at" is null))
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_kitchen_created_idx" ON "ai_usage" USING btree ("kitchen_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");