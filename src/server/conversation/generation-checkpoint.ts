import { getTableColumns, sql } from "drizzle-orm";
import { activeGenerationTable, generationCheckpointTable as checkpoint } from "../database/schema";
import type { ConversationDatabase } from "./internal";

// @approved
//  The Active Generation's checkpointed output, assembled from its delta rows
// in the query that reads the active row. The names match the replay columns
// they are retained into, so the replay copy carries them as it carries every
// other column.
const ofGeneration = sql`${checkpoint.generation_id} = ${activeGenerationTable.id}`;
export const checkpointColumns = {
	checkpoint_content: sql<string>`coalesce((select group_concat(${checkpoint.content}, '' order by ${checkpoint.event_id}) from ${checkpoint} where ${ofGeneration}), '')`,
	checkpoint_reasoning: sql<string>`coalesce((select group_concat(${checkpoint.reasoning}, '' order by ${checkpoint.event_id}) from ${checkpoint} where ${ofGeneration}), '')`,
	checkpoint_event_id: sql<number>`coalesce((select max(${checkpoint.event_id}) from ${checkpoint} where ${ofGeneration}), 0)`,
	checkpointed_at: sql<string | null>`(select ${checkpoint.checkpointed_at} from ${checkpoint} where ${ofGeneration} order by ${checkpoint.event_id} desc limit 1)`,
};

/** @approved The Active Generation rows with their assembled output. */
export const selectActiveGenerations = (db: ConversationDatabase) =>
	db.select({ ...getTableColumns(activeGenerationTable), ...checkpointColumns }).from(activeGenerationTable);
