CREATE TABLE `desktop_audio_chunks` (
	`key` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`direction` text NOT NULL,
	`generation` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `desktop_audio_expiry` ON `desktop_audio_chunks` (`created_at`);--> statement-breakpoint
CREATE INDEX `desktop_audio_stream` ON `desktop_audio_chunks` (`direction`,`generation`,`seq`);--> statement-breakpoint
CREATE TABLE `desktop_audio_state` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`status_json` text DEFAULT '{}' NOT NULL,
	`last_seen` integer DEFAULT 0 NOT NULL,
	`output_active` integer DEFAULT 0 NOT NULL,
	`input_owner` text DEFAULT '' NOT NULL,
	`output_generation` text NOT NULL,
	`input_generation` text NOT NULL,
	`output_sequence` integer DEFAULT 0 NOT NULL,
	`input_sequence` integer DEFAULT 0 NOT NULL,
	`output_slot` integer DEFAULT 0 NOT NULL,
	`output_count` integer DEFAULT 0 NOT NULL,
	`input_slot` integer DEFAULT 0 NOT NULL,
	`input_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `desktop_viewers` ADD `sound` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `desktop_viewers` ADD `mic` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `desktop_viewers` ADD `audio_revision` integer DEFAULT 0 NOT NULL;