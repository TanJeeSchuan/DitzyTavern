import { Elysia, t } from "elysia";
import { getCharacter } from "../server/database/character";
import { getWorkspace } from "../server/database/workspace";

const chatSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	creationTime: t.String(),
	lastMessageTime: t.String(),
	characterIds: t.Array(t.Integer()),
});

const characterSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
});

export const contract = new Elysia()
	.get("/api/health", () => ({ ok: true }), {
		response: t.Object({ ok: t.Boolean() }),
	})
	.get("/api/workspace", () => getWorkspace(), {
		response: t.Object({
			activeChatId: t.Nullable(t.Integer()),
			chats: t.Array(chatSummary),
			characters: t.Array(characterSummary),
		}),
	})
	.get(
		"/api/characters/:id",
		async ({ params, status }) => {
			const character = await getCharacter(params.id);

			if (!character) {
				return status(404, "Character not found");
			}

			return character;
		},
		{
			params: t.Object({ id: t.Numeric() }),
			response: {
				200: t.Object({
					id: t.Integer(),
					name: t.String(),
				}),
				404: t.String(),
			},
		},
	);

export type Contract = typeof contract;
