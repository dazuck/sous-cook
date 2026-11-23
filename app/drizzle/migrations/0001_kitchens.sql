CREATE TABLE "kitchen_webhook_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"token_sha256" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "kitchen_webhook_tokens_token_sha256_unique" UNIQUE("token_sha256"),
	CONSTRAINT "kitchen_webhook_tokens_sha256_shape" CHECK ("kitchen_webhook_tokens"."token_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "kitchen_webhook_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kitchens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"ai_monthly_cap_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchens_slug_unique" UNIQUE("slug"),
	CONSTRAINT "kitchens_slug_shape" CHECK ("kitchens"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("kitchens"."slug") <= 40),
	CONSTRAINT "kitchens_name_length" CHECK (length("kitchens"."name") between 1 and 80),
	CONSTRAINT "kitchens_cap_nonnegative" CHECK ("kitchens"."ai_monthly_cap_micros" is null or "kitchens"."ai_monthly_cap_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "kitchens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_logs" ADD COLUMN "kitchen_id" uuid;--> statement-breakpoint
ALTER TABLE "cook_reports" ADD COLUMN "kitchen_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_recipes" ADD COLUMN "kitchen_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD COLUMN "kitchen_id" uuid;--> statement-breakpoint
ALTER TABLE "recipe_ideas_cache" ADD COLUMN "kitchen_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_webhook_tokens" ADD CONSTRAINT "kitchen_webhook_tokens_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_webhook_tokens_kitchen_idx" ON "kitchen_webhook_tokens" USING btree ("kitchen_id");--> statement-breakpoint
ALTER TABLE "conversation_logs" ADD CONSTRAINT "conversation_logs_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cook_reports" ADD CONSTRAINT "cook_reports_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_recipes" ADD CONSTRAINT "doc_recipes_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD CONSTRAINT "kitchen_queue_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ideas_cache" ADD CONSTRAINT "recipe_ideas_cache_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_logs_kitchen_session_idx" ON "conversation_logs" USING btree ("kitchen_id","session_id");--> statement-breakpoint
CREATE INDEX "cook_reports_kitchen_created_idx" ON "cook_reports" USING btree ("kitchen_id","created_at");--> statement-breakpoint
CREATE INDEX "kitchen_queue_kitchen_status_idx" ON "kitchen_queue" USING btree ("kitchen_id","status","created_at");
--> statement-breakpoint
INSERT INTO "kitchens" ("slug", "name") VALUES ('home', 'Home');
--> statement-breakpoint
UPDATE "kitchen_queue" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home');
--> statement-breakpoint
UPDATE "doc_recipes" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home');
--> statement-breakpoint
UPDATE "recipe_ideas_cache" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home');
--> statement-breakpoint
UPDATE "conversation_logs" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home');
--> statement-breakpoint
UPDATE "cook_reports" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home');