CREATE TABLE "kitchen_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "kitchen_ideas_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"line" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchen_ideas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kitchen_pantry_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "kitchen_pantry_items_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchen_pantry_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kitchen_pantry_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "kitchen_pantry_sections_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"raw_heading" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchen_pantry_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kitchen_shopping_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "kitchen_shopping_list_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"line" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchen_shopping_list" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kitchen_ideas" ADD CONSTRAINT "kitchen_ideas_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pantry_items" ADD CONSTRAINT "kitchen_pantry_items_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pantry_items" ADD CONSTRAINT "kitchen_pantry_items_section_id_kitchen_pantry_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."kitchen_pantry_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pantry_sections" ADD CONSTRAINT "kitchen_pantry_sections_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_shopping_list" ADD CONSTRAINT "kitchen_shopping_list_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_ideas_kitchen_pos_idx" ON "kitchen_ideas" USING btree ("kitchen_id","position");--> statement-breakpoint
CREATE INDEX "kitchen_pantry_items_section_pos_idx" ON "kitchen_pantry_items" USING btree ("section_id","position");--> statement-breakpoint
CREATE INDEX "kitchen_pantry_items_kitchen_idx" ON "kitchen_pantry_items" USING btree ("kitchen_id");--> statement-breakpoint
CREATE INDEX "kitchen_pantry_sections_kitchen_pos_idx" ON "kitchen_pantry_sections" USING btree ("kitchen_id","position");--> statement-breakpoint
CREATE INDEX "kitchen_shopping_list_kitchen_pos_idx" ON "kitchen_shopping_list" USING btree ("kitchen_id","position");