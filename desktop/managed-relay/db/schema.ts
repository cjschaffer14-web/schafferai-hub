import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
export const agent = sqliteTable("desktop_agent", {
  id: text("id").primaryKey(), epoch: text("epoch").notNull(),
  statusJson: text("status_json").notNull().default("{}"), lastSeen: integer("last_seen").notNull().default(0),
  frameAt: integer("frame_at").notNull().default(0), frameId: text("frame_id").notNull().default(""),
  frameKey: text("frame_key").notNull().default(""), framesSlot: integer("frames_slot").notNull().default(0),
  frameRevision: integer("frame_revision").notNull().default(0),
  framesCount: integer("frames_count").notNull().default(0),
});
export const viewers = sqliteTable("desktop_viewers", {
  id: text("id").primaryKey(), epoch: text("epoch").notNull(), expiresAt: integer("expires_at").notNull(),
  inputsSlot: integer("inputs_slot").notNull().default(0), inputsCount: integer("inputs_count").notNull().default(0),
  batchId: text("batch_id").notNull().default(""),
}, table => [index("desktop_viewer_expiry").on(table.expiresAt)]);
export const events = sqliteTable("desktop_events", {
  id: integer("id").primaryKey({ autoIncrement: true }), epoch: text("epoch").notNull(), viewerId: text("viewer_id"),
  eventJson: text("event_json").notNull(), expiresAt: integer("expires_at").notNull(),
}, table => [index("desktop_event_epoch_id").on(table.epoch, table.id), index("desktop_event_expiry").on(table.expiresAt)]);
