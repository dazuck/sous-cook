CREATE TABLE "kitchen_cook_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "kitchen_cook_log_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"queue_id" uuid,
	"doc_recipe_id" uuid,
	"pack_source" text,
	"recipe_snapshot" jsonb,
	"recipe_title" text NOT NULL,
	"timestamp_text" text NOT NULL,
	"cooked_day" text NOT NULL,
	"cooked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cooked_by_member_id" uuid,
	"rating" integer,
	"notes" text DEFAULT '' NOT NULL,
	"note_private" boolean DEFAULT false NOT NULL,
	"note_updated_at" timestamp with time zone,
	"held_back" boolean DEFAULT false NOT NULL,
	"visibility_chosen" boolean DEFAULT false NOT NULL,
	CONSTRAINT "kitchen_cook_log_rating_range" CHECK ("kitchen_cook_log"."rating" is null or ("kitchen_cook_log"."rating" between 1 and 5))
);
--> statement-breakpoint
ALTER TABLE "kitchen_cook_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_recipes" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD COLUMN "completed_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchens" ADD COLUMN "about" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_cook_log" ADD CONSTRAINT "kitchen_cook_log_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_cook_log" ADD CONSTRAINT "kitchen_cook_log_doc_recipe_id_doc_recipes_id_fk" FOREIGN KEY ("doc_recipe_id") REFERENCES "public"."doc_recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_cook_log" ADD CONSTRAINT "kitchen_cook_log_cooked_by_member_id_members_id_fk" FOREIGN KEY ("cooked_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_cook_log_kitchen_pos_idx" ON "kitchen_cook_log" USING btree ("kitchen_id","position");--> statement-breakpoint
CREATE INDEX "kitchen_cook_log_kitchen_queue_idx" ON "kitchen_cook_log" USING btree ("kitchen_id","queue_id");--> statement-breakpoint
CREATE INDEX "kitchen_cook_log_kitchen_cooked_idx" ON "kitchen_cook_log" USING btree ("kitchen_id","cooked_at");--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD CONSTRAINT "kitchen_queue_completed_by_member_id_members_id_fk" FOREIGN KEY ("completed_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchens" ADD CONSTRAINT "kitchens_about_length" CHECK (char_length("kitchens"."about") <= 2000);