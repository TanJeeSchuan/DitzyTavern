import type { Database } from "bun:sqlite";
import { Elysia, sse, status } from "elysia";
import { subscriptionEvents, type BoxExports } from "@/box-sdk/server";
import { notFoundOutcome } from "@/box-sdk/shared";
import { draftRequest, drafterConversationParams, drafterRead, type DraftEvent } from "./contract";
import { draftPerson, readDrafter } from "./server-draft";

// @approved
//  The drafter's read for its window and its one draft stream, served under
// `/api/boxes/character-drafter`. The stream sends each step the agent runs,
// then the draft or why it failed, and closing it cancels the run; nothing
// is stored.
export const drafterRoutes = (database: Database, exportsOf: (conversationId: number) => BoxExports) => new Elysia()
	.get("/conversations/:id", ({ params }) => readDrafter(database, params.id, exportsOf) ?? status(404, { outcome: "not-found" as const }),
		{ params: drafterConversationParams, response: { 200: drafterRead, 404: notFoundOutcome } })
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
