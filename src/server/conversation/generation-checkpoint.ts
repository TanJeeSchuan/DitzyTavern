import { getTableColumns, sql } from "drizzle-orm";
import { activeGenerationTable } from "../database/schema";
import type { ConversationDatabase } from "./internal";

// @approved
//  The subqueries name every column through a table or alias: drizzle leaves
// columns unqualified in a single-table select, and an unqualified `id` would
// bind to the subquery's own table instead of the outer row.
const ofActiveRow = sql.raw(`from generation_checkpoint c where c.generation_id = "active_generation"."id"`);

// @approved
//  The Active Generation's checkpointed output, assembled from its delta rows
// in the query that reads the active row. The names match the replay columns
// they are retained into, so the replay copy carries them as it carries every
// other column.
export const checkpointColumns = {
	checkpoint_content: sql<string>`coalesce((select group_concat(c.content, '' order by c.event_id) ${ofActiveRow}), '')`,
	checkpoint_reasoning: sql<string>`coalesce((select group_concat(c.reasoning, '' order by c.event_id) ${ofActiveRow}), '')`,
	checkpoint_event_id: sql<number>`coalesce((select max(c.event_id) ${ofActiveRow}), 0)`,
	checkpointed_at: sql<string | null>`(select c.checkpointed_at ${ofActiveRow} order by c.event_id desc limit 1)`,
};

/** @approved The Active Generation rows with their assembled output. */
export const selectActiveGenerations = (db: ConversationDatabase) =>
	db.select({ ...getTableColumns(activeGenerationTable), ...checkpointColumns }).from(activeGenerationTable);

// @approved
//  A Variant's content as readers see it: an Active Generation's Variant
// holds its acceptance content until termination, so its text is the
// assembled checkpoints. The subquery scans only the handful of Active
// Generation rows, so an ordinary Variant pays almost nothing for it.
export const liveVariantContent = sql<string>`coalesce((select group_concat(c.content, '' order by c.event_id) from generation_checkpoint c join active_generation a on a.id = c.generation_id where a.variant_id = "message_variant"."id"), "message_variant"."content")`;
