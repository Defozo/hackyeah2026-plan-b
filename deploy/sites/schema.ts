import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const limits = sqliteTable(
  "limits",
  {
    bucket: text("bucket").primaryKey(),
    count: integer("count").notNull(),
    expires: integer("expires").notNull(),
  },
  (table) => [index("limits_expires").on(table.expires)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    csrf: text("csrf").notNull(),
    expires: integer("expires").notNull(),
  },
  (table) => [index("sessions_expires").on(table.expires)],
);
