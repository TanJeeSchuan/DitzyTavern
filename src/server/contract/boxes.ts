import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Elysia } from "elysia";
import { boxClientFolder, boxRoutes, clearHeldValues, heldBoxValues as held } from "../box/registry";
import { boxList, boxParams as params, heldBoxValues, heldBoxValuesCleared, installedBoxes } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { notFoundResponse } from "./responses";
import { revalidatedFile } from "./content-validators";

// @approved
//  The loaded Boxes, and the routes each Box serves beside the host's,
// under its own `/api/boxes/<id>`: the routes the loader built and mounted
// for the server's database. Each Box's client module, and the stylesheet it
// links, are served from its client folder, and revalidated, since they keep
// their names across builds. A Box's held values are listed, and cleared on
// request, beside it.
export const createBoxRoutes = (database: Database) => {
	const app = new Elysia()
		.get("/api/boxes", () => [...installedBoxes().values()].map(({ metadata }) => ({ ...metadata, client: `/boxes/${metadata.id}/client.js` })), { response: boxList })
		.get("/api/box-held-values", () => Object.fromEntries([...held()].map(([id, places]) => [id, [...places]])), { response: heldBoxValues })
		.post("/api/boxes/:box/held-values/clear", ({ params: { box } }) => {
			if (!held().has(box)) return notFoundResponse();
			clearHeldValues(database, box);
			return { outcome: "cleared" as const };
		}, { params, response: { 200: heldBoxValuesCleared, 404: notFoundOutcome } })
		.get("/boxes/:box/:file", async ({ params: { box, file }, request, status }) => {
			const folder = boxClientFolder(box);
			const served = folder === undefined || (file !== "client.js" && file !== "client.css") ? undefined : Bun.file(join(folder, file));
			if (served === undefined || !await served.exists()) return status(404, "There is no such Box client file.");
			return revalidatedFile(request, served);
		});
	for (const routes of boxRoutes()) app.use(routes);
	return app;
};
