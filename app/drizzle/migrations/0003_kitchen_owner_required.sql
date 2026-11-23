UPDATE "kitchen_queue" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home') WHERE "kitchen_id" IS NULL;
--> statement-breakpoint
UPDATE "doc_recipes" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home') WHERE "kitchen_id" IS NULL;
--> statement-breakpoint
UPDATE "recipe_ideas_cache" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home') WHERE "kitchen_id" IS NULL;
--> statement-breakpoint
UPDATE "conversation_logs" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home') WHERE "kitchen_id" IS NULL;
--> statement-breakpoint
UPDATE "cook_reports" SET "kitchen_id" = (SELECT "id" FROM "kitchens" WHERE "slug" = 'home') WHERE "kitchen_id" IS NULL;
--> statement-breakpoint
DELETE FROM "recipe_ideas_cache" WHERE "id" IN (SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "kitchen_id" ORDER BY "synced_at" DESC, "id" DESC) AS "n" FROM "recipe_ideas_cache") AS "ranked" WHERE "n" > 1);
--> statement-breakpoint
ALTER TABLE "doc_recipes" DROP CONSTRAINT "doc_recipes_doc_slug_unique";--> statement-breakpoint
ALTER TABLE "conversation_logs" ALTER COLUMN "kitchen_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cook_reports" ALTER COLUMN "kitchen_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_recipes" ALTER COLUMN "kitchen_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ALTER COLUMN "kitchen_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_ideas_cache" ALTER COLUMN "kitchen_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_recipes" ADD CONSTRAINT "doc_recipes_kitchen_slug_unique" UNIQUE("kitchen_id","doc_slug");--> statement-breakpoint
ALTER TABLE "recipe_ideas_cache" ADD CONSTRAINT "recipe_ideas_cache_kitchen_unique" UNIQUE("kitchen_id");