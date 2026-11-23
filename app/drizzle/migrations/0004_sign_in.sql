CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"kitchen_id" uuid,
	"new_kitchen_name" text,
	"new_kitchen_slug" text,
	"role" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invites_email_normalized" CHECK ("invites"."email" = lower(btrim("invites"."email")) and position('@' in "invites"."email") > 1),
	CONSTRAINT "invites_new_kitchen_name_length" CHECK (length("invites"."new_kitchen_name") between 1 and 80),
	CONSTRAINT "invites_new_kitchen_slug_shape" CHECK ("invites"."new_kitchen_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("invites"."new_kitchen_slug") <= 40),
	CONSTRAINT "invites_role_known" CHECK ("invites"."role" in ('owner', 'cook')),
	CONSTRAINT "invites_target_one" CHECK (("invites"."kitchen_id" is null) <> ("invites"."new_kitchen_name" is null)),
	CONSTRAINT "invites_new_kitchen_pair" CHECK (("invites"."new_kitchen_name" is null) = ("invites"."new_kitchen_slug" is null)),
	CONSTRAINT "invites_new_kitchen_owner" CHECK ("invites"."new_kitchen_name" is null or "invites"."role" = 'owner')
);
--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kitchen_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "members_role_known" CHECK ("members"."role" in ('owner', 'cook'))
);
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "auth_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "auth_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_logs" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "cook_reports" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_user_id_auth_user_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_kitchen_id_kitchens_id_fk" FOREIGN KEY ("kitchen_id") REFERENCES "public"."kitchens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_live_email_unique" ON "invites" USING btree ("email") WHERE "invites"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_pending_slug_unique" ON "invites" USING btree ("new_kitchen_slug") WHERE "invites"."revoked_at" is null and "invites"."accepted_at" is null;--> statement-breakpoint
CREATE INDEX "members_kitchen_idx" ON "members" USING btree ("kitchen_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "conversation_logs" ADD CONSTRAINT "conversation_logs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cook_reports" ADD CONSTRAINT "cook_reports_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;