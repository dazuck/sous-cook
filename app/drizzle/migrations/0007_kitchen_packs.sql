CREATE TABLE "kitchen_pack_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_pack_id" uuid NOT NULL,
	"shared_with_kitchen_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_pack_shares_unique" UNIQUE("kitchen_pack_id","shared_with_kitchen_id")
);
--> statement-breakpoint
ALTER TABLE "kitchen_pack_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kitchen_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"pack_id" text NOT NULL,
	"pack_json" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_packs_kitchen_pack_unique" UNIQUE("kitchen_id","pack_id"),
	CONSTRAINT "kitchen_packs_size_limit" CHECK ("kitchen_packs"."size_bytes" > 0 and "kitchen_packs"."size_bytes" <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "kitchen_packs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kitchen_pack_shares" ADD CONSTRAINT "kitchen_pack_shares_kitchen_pack_id_kitchen_packs_id_fk" FOREIGN KEY ("kitchen_pack_id") REFERENCES "public"."kitchen_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_pack_shares" ADD CONSTRAINT "kitchen_pack_shares_shared_with_kitchen_id_kitchens_id_fk" FOREIGN KEY ("shared_with_kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_packs" ADD CONSTRAINT "kitchen_packs_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_pack_shares_shared_with_idx" ON "kitchen_pack_shares" USING btree ("shared_with_kitchen_id");