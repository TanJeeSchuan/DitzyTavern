import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Elysia } from "elysia";
import { boxClientSource, boxRoutes, clearHeldValues, heldBoxValues as held } from "../box/registry";
import { boxFrameResponse } from "../box/frame";
import { boxFrameRoute } from "../../shared/box-frame";
import { boxList } from "../../shared/contract/box-sandboxed";
import { boxParams as params, heldBoxValues, heldBoxValuesCleared, installedBoxes } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { notFoundResponse } from "./responses";
import { recoverActiveGenerations } from "../workflows";
import { revalidatedFile } from "./content-validators";

/** @approved The files the host serves for each kind of Box client: a trusted Box's built module and stylesheet, a sandboxed Box's frame code and stylesheet. */
const clientFiles = { module: ["client.js", "client.css"], sandboxed: ["ui.js", "ui.css"] };

// @approved
//  The loaded Boxes, and the routes each Box serves beside the host's,
// under its own `/api/boxes/<id>`: the routes the loader built and mounted
// for the server's database. A trusted Box is listed with its client
// module's URL, a sandboxed one with its descriptor, which the client builds
// its surfaces from. Each Box's client files are served from its client
// folder, and revalidated, since they keep their names across builds. A
// Box's held values are listed, and cleared on request, beside it. Every
// Box frame loads its document from the frame route.
export const createBoxRoutes = (database: Database) => {
	const app = new Elysia()
		.get("/api/boxes", () => [...installedBoxes().values()].map(({ metadata }) => {
			const source = boxClientSource(metadata.id);
			return source?.kind === "sandboxed" ? { ...metadata, sandboxed: source.file } : { ...metadata, client: `/boxes/${metadata.id}/client.js` };
		}), { response: boxList })
		.get(boxFrameRoute, ({ request }) => boxFrameResponse(request.headers.get("host") ?? new URL(request.url).host))
		.get("/api/box-held-values", () => Object.fromEntries([...held()].map(([id, places]) => [id, [...places]])), { response: heldBoxValues })
		.post("/api/boxes/:box/held-values/clear", ({ params: { box } }) => {
			if (!held().has(box)) return notFoundResponse();
			// @approved
			//  A held setup fails every capture in its Chat, so an Active
			// Generation there predates the load and startup recovery failed on
			// it. Once the setup is gone it is recovered, in this same turn,
			// before any new Generation could start there.
			const conversationIds = clearHeldValues(database, box);
			if (conversationIds.length > 0) recoverActiveGenerations(database, { conversationIds });
			return { outcome: "cleared" as const };
		}, { params, response: { 200: heldBoxValuesCleared, 404: notFoundOutcome } })
		.get("/boxes/:box/:file", async ({ params: { box, file }, request, status }) => {
			const source = boxClientSource(box);
			const served = source === undefined || !clientFiles[source.kind].includes(file) ? undefined : Bun.file(join(source.folder, file));
			if (served === undefined || !await served.exists()) return status(404, "There is no such Box client file.");
			return revalidatedFile(request, served);
		});
	for (const routes of boxRoutes()) app.use(routes);
	return app;
};
