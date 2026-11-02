import { isNull, type SQLWrapper } from "drizzle-orm";

export const isActive = (table: { deleted_at: SQLWrapper }) => isNull(table.deleted_at);
