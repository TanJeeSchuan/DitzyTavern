import type { Database } from "bun:sqlite";
import type { Portrait } from "../../shared/contract/image";

export const listChatSummaries = (database: Database) =>
	database
			.query<{ id: number; name: string; creation_time: string; last_message_time: string; cast_names: string | null; cast_portraits: string; excerpt: string | null }, []>(`
				SELECT c.id, c.name, c.creation_time, c.last_message_time,
					(SELECT group_concat(name, char(31)) FROM (SELECT name FROM participant WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY position)) AS cast_names,
					(SELECT json_group_array(CASE WHEN pp.portrait_hash IS NULL OR pp.portrait_focal_x IS NULL OR pp.portrait_focal_y IS NULL THEN NULL ELSE json_object('hash', pp.portrait_hash, 'focalX', pp.portrait_focal_x, 'focalY', pp.portrait_focal_y) END ORDER BY p.position) FROM participant p LEFT JOIN participant_prompt pp ON pp.participant_id = p.id WHERE p.conversation_id = c.id AND p.deleted_at IS NULL) AS cast_portraits,
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
				castNames: chat.cast_names?.split("") ?? [],
				// SAFETY: SQLite builds this array from Portrait columns, emitting null for incomplete Portraits.
				castPortraits: JSON.parse(chat.cast_portraits) as (Portrait | null)[],
				excerpt: (chat.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
			}));
