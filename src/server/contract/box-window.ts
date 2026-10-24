import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { conversationBoxParams as params, isDigestBox, type BoxId } from "../../shared/contract/box";
import { boxValue } from "../../shared/contract/box-value";
import { digestPassageCommand, digestStatusRead } from "../../shared/contract/box-digest";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { cancelBoxCatchUp, queueBoxDigest, readDigest, readDigestStatus, startBoxCatchUp } from "../box/digest";
import { serverBox } from "../box/registry";
import { readBoxWindow } from "../box/window";
import { notFoundResponse } from "./responses";

const readResponse = { 200: boxValue, 404: notFoundOutcome };
/** @approved A digesting Box's window read is the host's passage timeline; any other Box serves its own `read` over the host's window read, and an unknown id has none. */
const readBox = (database: Database, conversationId: number, id: BoxId) => {
	if (isDigestBox(id)) return readDigest(database, conversationId, id);
	const box = serverBox(id);
	return box?.read === undefined ? undefined : readBoxWindow(database, conversationId, id, box, ({ slots: _slots, ...window }) => box.read?.(window));
};

export const createBoxWindowRoutes = (database: Database) => new Elysia()
	.get("/api/conversations/:id/boxes/:box", ({ params }) => readBox(database, params.id, params.box) ?? notFoundResponse(),
		{ params, response: readResponse })
	.get("/api/conversations/:id/boxes/:box/status", ({ params }) => (isDigestBox(params.box) ? readDigestStatus(database, params.id, params.box) : undefined) ?? notFoundResponse(),
		{ params, response: { 200: digestStatusRead, 404: notFoundOutcome } })
	// @approved
	//  Catch-up, cancellation and digesting one passage are in-memory queue
	//  work, not Conversation state, so they are their own routes: the polled
	//  digest read carries their progress and they never touch the
	//  Conversation revision. Only a digesting Box has them.
	.post(
		"/api/conversations/:id/boxes/:box/digest",
		({ params, body }) => {
			if (!isDigestBox(params.box)) return notFoundResponse();
			queueBoxDigest(database, params.id, params.box, body.variantId);
			return readDigest(database, params.id, params.box) ?? notFoundResponse();
		},
		{ params, body: digestPassageCommand, response: readResponse },
	)
	.post(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			if (!isDigestBox(params.box)) return notFoundResponse();
			startBoxCatchUp(database, params.id, params.box);
			return readDigest(database, params.id, params.box) ?? notFoundResponse();
		},
		{ params, response: readResponse },
	)
	.delete(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			if (!isDigestBox(params.box)) return notFoundResponse();
			cancelBoxCatchUp(database, params.id, params.box);
			return readDigest(database, params.id, params.box) ?? notFoundResponse();
		},
		{ params, response: readResponse },
	);
