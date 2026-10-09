import type { Database } from "bun:sqlite";
import type { Portrait } from "../../shared/contract/image";

// @approved
//  The Workspace Chat list read model: one row per Conversation in recency
//  order with its Cast and the selected Variant of its last Message, so the
//  workspace route never reaches into Conversation tables itself.

export const listChatSummaries = (database: Database) =>
	database
			.query<{ id: number; name: string; creation_time: string; last_message_time: string; cast: string; excerpt: string | null }, []>(`
				SELECT c.id, c.name, c.creation_time, c.last_message_time,
					(SELECT json_group_array(json_object('name', p.name, 'portrait', CASE WHEN pp.portrait_hash IS NULL THEN NULL ELSE json_object('hash', pp.portrait_hash, 'focalX', pp.portrait_focal_x, 'focalY', pp.portrait_focal_y) END) ORDER BY p.position) FROM participant p LEFT JOIN participant_prompt pp ON pp.participant_id = p.id WHERE p.conversation_id = c.id AND p.deleted_at IS NULL) AS cast,
					(SELECT v.content FROM messages m JOIN message_variant v ON v.message_id = m.id AND v.selected = 1
						WHERE m.conversation_id = c.id ORDER BY m.position DESC LIMIT 1) AS excerpt
				FROM conversation c
				ORDER BY c.last_message_time DESC`)
			.all()
			.map((chat) => ({
				id: chat.id,
				name: chat.name,
				creationTime: chat.creation_time,
				lastMessageTime: chat.last_message_time,
				// @approved
				//  SAFETY: SQLite builds each name/Portrait pair; CHECK constraints require complete Portraits.
				cast: JSON.parse(chat.cast) as { name: string; portrait: Portrait | null }[],
				excerpt: (chat.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
			}));
