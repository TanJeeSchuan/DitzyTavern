import type { Database } from "bun:sqlite";
import { Elysia, sse } from "elysia";
import { subscriptionEvents, type BoxExports } from "@/box-sdk/server";
import { draftRequest, drafterConversationParams, drafterRead, type DraftEvent } from "./contract";
import { draftPerson, readDrafter } from "./server-draft";

// @approved
//  The drafter's read for its window and its one draft stream, served under
// `/api/boxes/character-drafter`. The stream sends each step the agent runs,
// then the draft or why it failed, and closing it cancels the run; nothing
// is stored.
export const drafterRoutes = (database: Database, exportsOf: (conversationId: number) => BoxExports) => new Elysia()
	.get("/conversations/:id", ({ params }) => readDrafter(database, exportsOf(params.id)), { params: drafterConversationParams, response: drafterRead })
	.post("/draft", ({ body, request, set }) => subscriptionEvents({ request, set }, (emit, close) => {
		const run = new AbortController();
		const send = (event: DraftEvent) => emit(sse({ data: event }));
		const finish = async () => {
			try {
				send({ type: "draft", draft: await draftPerson(database, exportsOf(body.conversationId), body, run.signal, (activity) => send({ type: "activity", activity })) });
			} catch (error) {
				send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
			} finally { close(); }
		};
		void finish();
		return () => run.abort();
	}), { body: draftRequest });
export type DrafterRoutes = ReturnType<typeof drafterRoutes>;
