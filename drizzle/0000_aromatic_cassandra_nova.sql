CREATE TABLE `migration_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owner_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
