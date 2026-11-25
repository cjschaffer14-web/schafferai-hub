CREATE TABLE `desktop_agent` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`status_json` text DEFAULT '{}' NOT NULL,
	`last_seen` integer DEFAULT 0 NOT NULL,
	`frame_at` integer DEFAULT 0 NOT NULL,
	`frame_id` text DEFAULT '' NOT NULL,
	`frame_key` text DEFAULT '' NOT NULL,
	`frames_slot` integer DEFAULT 0 NOT NULL,
	`frames_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `desktop_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`epoch` text NOT NULL,
	`viewer_id` text,
	`event_json` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `desktop_event_epoch_id` ON `desktop_events` (`epoch`,`id`);--> statement-breakpoint
CREATE INDEX `desktop_event_expiry` ON `desktop_events` (`expires_at`);--> statement-breakpoint
CREATE TABLE `desktop_viewers` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`expires_at` integer NOT NULL,
	`inputs_slot` integer DEFAULT 0 NOT NULL,
	`inputs_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `desktop_viewer_expiry` ON `desktop_viewers` (`expires_at`);