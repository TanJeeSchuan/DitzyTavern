import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { boxWindowParams, worldClockRead } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { cancelBoxCatchUp, startBoxCatchUp } from "../box/digest";
import { readWorldClock } from "../box/window";
import { notFoundResponse } from "./responses";

const catchUpResponse = { 200: worldClockRead, 404: notFoundOutcome };

export const createBoxWindowRoutes = (database: Database) => new Elysia()
	.get(
		"/api/conversations/:id/boxes/:box",
		({ params }) => readWorldClock(database, params.id) ?? notFoundResponse(),
		{ params: boxWindowParams, response: { 200: worldClockRead, 404: notFoundOutcome } },
	)
	// @approved
	//  Catch-up and cancellation are in-memory queue work, not Conversation
	//  state, so they are their own routes: the polled window read carries the
	//  run's progress and the run never touches the Conversation revision.
	.post(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			startBoxCatchUp(database, params.id);
			return readWorldClock(database, params.id) ?? notFoundResponse();
		},
		{ params: boxWindowParams, response: catchUpResponse },
	)
	.delete(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			cancelBoxCatchUp(database, params.id);
			return readWorldClock(database, params.id) ?? notFoundResponse();
		},
		{ params: boxWindowParams, response: catchUpResponse },
	);
