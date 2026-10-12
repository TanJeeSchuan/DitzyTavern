import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { boxRead, boxReadParams, boxWindowParams, isDigestBoxId, type BoxId } from "../../shared/contract/box";
import { digestStatusRead } from "../../shared/contract/box-digest";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { cancelBoxCatchUp, readDigest, readDigestStatus, startBoxCatchUp } from "../box/digest";
import { serverBox } from "../box/registry";
import { notFoundResponse } from "./responses";

const readResponse = { 200: boxRead, 404: notFoundOutcome };
/** @approved A digesting Box's window read is the host's passage timeline; any other Box serves its own `read`. */
const readBox = (database: Database, conversationId: number, box: BoxId) =>
	isDigestBoxId(box) ? readDigest(database, conversationId, box) : serverBox(box).read?.(database, conversationId);

export const createBoxWindowRoutes = (database: Database) => new Elysia()
	.get("/api/conversations/:id/boxes/:box", ({ params }) => readBox(database, params.id, params.box) ?? notFoundResponse(),
		{ params: boxReadParams, response: readResponse })
	.get("/api/conversations/:id/boxes/:box/status", ({ params }) => readDigestStatus(database, params.id, params.box) ?? notFoundResponse(),
		{ params: boxWindowParams, response: { 200: digestStatusRead, 404: notFoundOutcome } })
	// @approved
	//  Catch-up and cancellation are in-memory queue work, not Conversation
	//  state, so they are their own routes: the polled digest read carries the
	//  run's progress and the run never touches the Conversation revision.
	.post(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			startBoxCatchUp(database, params.id, params.box);
			return readDigest(database, params.id, params.box) ?? notFoundResponse();
		},
		{ params: boxWindowParams, response: readResponse },
	)
	.delete(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			cancelBoxCatchUp(database, params.id, params.box);
			return readDigest(database, params.id, params.box) ?? notFoundResponse();
		},
		{ params: boxWindowParams, response: readResponse },
	);
