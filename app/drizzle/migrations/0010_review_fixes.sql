ALTER TABLE "kitchen_cook_log" ADD COLUMN "source_kitchen_pack_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_cook_log" ADD COLUMN "recipe_is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD COLUMN "started_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD COLUMN "source_kitchen_pack_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_queue" ADD CONSTRAINT "kitchen_queue_started_by_member_id_members_id_fk" FOREIGN KEY ("started_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "kitchen_cook_log" l
SET "recipe_is_private" = true
FROM "kitchen_queue" q
WHERE l."kitchen_id" = q."kitchen_id"
  AND l."queue_id" = q."id"
  AND q."is_private" = true;--> statement-breakpoint
UPDATE "kitchen_cook_log" l
SET "recipe_is_private" = true
FROM "doc_recipes" d
WHERE l."kitchen_id" = d."kitchen_id"
  AND l."doc_recipe_id" = d."id"
  AND d."is_private" = true;--> statement-breakpoint
UPDATE "kitchen_queue" q
SET "source_kitchen_pack_id" = (
  SELECT kp."id"
  FROM "kitchen_packs" kp
  WHERE kp."pack_id" = split_part(regexp_replace(q."recipe_data"->>'source', '^(pack-adapted|pack):', ''), '/', 1)
    AND (
      kp."kitchen_id" = q."kitchen_id"
      OR EXISTS (
        SELECT 1
        FROM "kitchen_pack_shares" s
        WHERE s."kitchen_pack_id" = kp."id"
          AND s."shared_with_kitchen_id" = q."kitchen_id"
      )
    )
  ORDER BY (kp."kitchen_id" = q."kitchen_id") DESC
  LIMIT 1
)
WHERE q."source_kitchen_pack_id" IS NULL
  AND (
    (q."recipe_data"->>'source') LIKE 'pack:%'
    OR (q."recipe_data"->>'source') LIKE 'pack-adapted:%'
  );--> statement-breakpoint
UPDATE "kitchen_cook_log" l
SET "source_kitchen_pack_id" = COALESCE(
  (
    SELECT q."source_kitchen_pack_id"
    FROM "kitchen_queue" q
    WHERE q."kitchen_id" = l."kitchen_id"
      AND q."id" = l."queue_id"
    LIMIT 1
  ),
  (
    SELECT kp."id"
    FROM "kitchen_packs" kp
    WHERE kp."pack_id" = split_part(regexp_replace(COALESCE(l."pack_source", l."recipe_snapshot"->>'source'), '^(pack-adapted|pack):', ''), '/', 1)
      AND (
        kp."kitchen_id" = l."kitchen_id"
        OR EXISTS (
          SELECT 1
          FROM "kitchen_pack_shares" s
          WHERE s."kitchen_pack_id" = kp."id"
            AND s."shared_with_kitchen_id" = l."kitchen_id"
        )
      )
    ORDER BY (kp."kitchen_id" = l."kitchen_id") DESC
    LIMIT 1
  )
)
WHERE l."source_kitchen_pack_id" IS NULL
  AND (
    COALESCE(l."pack_source", l."recipe_snapshot"->>'source') LIKE 'pack:%'
    OR COALESCE(l."pack_source", l."recipe_snapshot"->>'source') LIKE 'pack-adapted:%'
  );