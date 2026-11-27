import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
export const agent = sqliteTable("desktop_agent", {
  id: text("id").primaryKey(), epoch: text("epoch").notNull(),
  statusJson: text("status_json").notNull().default("{}"), lastSeen: integer("last_seen").notNull().default(0),
  frameAt: integer("frame_at").notNull().default(0), frameId: text("frame_id").notNull().default(""),
  frameKey: text("frame_key").notNull().default(""), framesSlot: integer("frames_slot").notNull().default(0),
  frameRevision: integer("frame_revision").notNull().default(0),
  frameReservedSequence: integer("frame_reserved_sequence").notNull().default(0),
  framePublishedSequence: integer("frame_published_sequence").notNull().default(0),
  framesCount: integer("frames_count").notNull().default(0),
});
export const viewers = sqliteTable("desktop_viewers", {
  id: text("id").primaryKey(), epoch: text("epoch").notNull(), expiresAt: integer("expires_at").notNull(),
  inputsSlot: integer("inputs_slot").notNull().default(0), inputsCount: integer("inputs_count").notNull().default(0),
  batchId: text("batch_id").notNull().default(""),
  sound: integer("sound").notNull().default(0), mic: integer("mic").notNull().default(0),
  audioRevision: integer("audio_revision").notNull().default(0),
}, table => [index("desktop_viewer_expiry").on(table.expiresAt)]);
export const events = sqliteTable("desktop_events", {
  id: integer("id").primaryKey({ autoIncrement: true }), epoch: text("epoch").notNull(), viewerId: text("viewer_id"),
  eventJson: text("event_json").notNull(), expiresAt: integer("expires_at").notNull(),
}, table => [index("desktop_event_epoch_id").on(table.epoch, table.id), index("desktop_event_expiry").on(table.expiresAt)]);

export const audioState = sqliteTable("desktop_audio_state", {
  id: text("id").primaryKey(), epoch: text("epoch").notNull(),
  statusJson: text("status_json").notNull().default("{}"), lastSeen: integer("last_seen").notNull().default(0),
  outputActive: integer("output_active").notNull().default(0), inputOwner: text("input_owner").notNull().default(""),
  outputGeneration: text("output_generation").notNull(), inputGeneration: text("input_generation").notNull(),
  outputSequence: integer("output_sequence").notNull().default(0), inputSequence: integer("input_sequence").notNull().default(0),
  outputSlot: integer("output_slot").notNull().default(0), outputCount: integer("output_count").notNull().default(0),
  inputSlot: integer("input_slot").notNull().default(0), inputCount: integer("input_count").notNull().default(0),
});
export const audioChunks = sqliteTable("desktop_audio_chunks", {
  key: text("key").primaryKey(), epoch: text("epoch").notNull(), direction: text("direction").notNull(),
  generation: text("generation").notNull(), seq: integer("seq").notNull(), createdAt: integer("created_at").notNull(),
}, table => [index("desktop_audio_expiry").on(table.createdAt), index("desktop_audio_stream").on(table.direction, table.generation, table.seq)]);
