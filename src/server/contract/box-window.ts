import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationBoxParams as params, type BoxId } from "../../shared/contract/box";
import { boxValue } from "../../shared/contract/box-value";
import { boxFrameOpen, boxFrameOpened } from "../../shared/contract/box-sandboxed";
import { delegateRead, digestPassageCommand, digestStatusRead } from "../../shared/contract/box-digest";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { cancelBoxCatchUp, digestView, queueBoxDigest, readDelegate, readDigest, readDigestStatus, startBoxCatchUp } from "../box/digest";
import { chatBox, withBoxOperations } from "../box/registry";
import { openBoxFrame } from "../box/frame";
import { readBoxLifecycles } from "../box/setup";
import { readBoxWindow } from "../box/window";
import { notFoundResponse } from "./responses";

const operation = <T>(database: Database, conversationId: number, id: BoxId, read: () => T) => {
	const loaded = chatBox(drizzle(database), conversationId, id);
	return withBoxOperations(loaded === undefined ? [] : [loaded], read);
};

const readResponse = { 200: boxValue, 404: notFoundOutcome };
/** @approved What the queue routes answer with: a digesting Box's passage timeline, or a delegating Box's notice read. */
const queueRead = (database: Database, conversationId: number, id: BoxId) => operation(database, conversationId, id, () => readDigest(database, conversationId, id) ?? readDelegate(database, conversationId, id) ?? notFoundResponse());
/** @approved A digesting Box's window read is the host's passage timeline; any other Box serves its own `read` over the host's window read, each at the version the Chat runs; an unknown id has none. */
const readBox = (database: Database, conversationId: number, id: BoxId) => readBoxWindow(database, conversationId, id, (window, loaded) => {
	if (loaded.descriptor.decision !== undefined) return digestView(database, window, id, loaded);
	const { slots: _slots, ...read } = window;
	return loaded.box.read?.(read);
});

export const createBoxWindowRoutes = (database: Database) => new Elysia()
	.get("/api/conversations/:id/boxes/:box", ({ params }) => operation(database, params.id, params.box, () => readBox(database, params.id, params.box) ?? notFoundResponse()),
		{ params, response: readResponse })
	// @approved
	//  The app opens a frame for a sandboxed Box with a `ui.js` present in the
	// Chat, naming the version its frame runs, which must be the one the Chat
	// pins. The token it gets back binds that frame to the Box, the Chat, the
	// Box's instance there and that version.
	.post("/api/conversations/:id/boxes/:box/frame", ({ params, body }) => {
		const db = drizzle(database);
		const instance = readBoxLifecycles(db, params.id)[params.box]?.instance;
		const loaded = instance === undefined ? undefined : chatBox(db, params.id, params.box);
		return loaded?.client.kind === "sandboxed" && loaded.client.ui !== undefined && instance !== undefined && loaded.version === body.version
			? { token: openBoxFrame({ box: params.box, conversationId: params.id, instance, version: loaded.version }) } : notFoundResponse();
	}, { params, body: boxFrameOpen, response: { 200: boxFrameOpened, 404: notFoundOutcome } })
	.get("/api/conversations/:id/boxes/:box/status", ({ params }) => operation(database, params.id, params.box, () => readDigestStatus(database, params.id, params.box) ?? notFoundResponse()),
		{ params, response: { 200: digestStatusRead, 404: notFoundOutcome } })
	.get("/api/conversations/:id/boxes/:box/delegate", ({ params }) => operation(database, params.id, params.box, () => readDelegate(database, params.id, params.box) ?? notFoundResponse()),
		{ params, response: { 200: delegateRead, 404: notFoundOutcome } })
	// @approved
	//  Catch-up, cancellation and digesting one passage are in-memory queue
	//  work, not Conversation state, so they are their own routes: the polled
	//  digest read carries their progress and they never touch the
	//  Conversation revision. Only a Box that digests in this Chat has them;
	//  the queue does nothing for any other, and its read is a 404.
	.post(
		"/api/conversations/:id/boxes/:box/digest",
		({ params, body }) => {
			queueBoxDigest(database, params.id, params.box, body);
			return queueRead(database, params.id, params.box);
		},
		{ params, body: digestPassageCommand, response: readResponse },
	)
	.post(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			startBoxCatchUp(database, params.id, params.box);
			return queueRead(database, params.id, params.box);
		},
		{ params, response: readResponse },
	)
	.delete(
		"/api/conversations/:id/boxes/:box/catch-up",
		({ params }) => {
			cancelBoxCatchUp(database, params.id, params.box);
			return queueRead(database, params.id, params.box);
		},
		{ params, response: readResponse },
	);
