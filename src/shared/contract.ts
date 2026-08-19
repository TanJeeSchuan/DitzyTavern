import { Elysia, t } from "elysia";
import { getCharacter } from "../server/database/character";

export const contract = new Elysia()
	.get("/api/health", () => ({ ok: true }), {
		response: t.Object({ ok: t.Boolean() }),
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
