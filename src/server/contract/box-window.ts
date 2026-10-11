import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { boxWindowParams, worldClockRead } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { readWorldClock } from "../box/window";
import { notFoundResponse } from "./responses";

export const createBoxWindowRoutes = (database: Database) => new Elysia()
	.get(
		"/api/conversations/:id/boxes/:box",
		({ params }) => readWorldClock(database, params.id) ?? notFoundResponse(),
		{ params: boxWindowParams, response: { 200: worldClockRead, 404: notFoundOutcome } },
	);
