import { join } from "node:path";
import { Elysia } from "elysia";
import { boxClientFolder, boxRoutes } from "../box/registry";
import { boxList, installedBoxes } from "../../shared/contract/box";

// @approved
//  The loaded Boxes, and the routes each Box serves beside the host's,
// under its own `/api/boxes/<id>`: the routes the loader built and mounted
// for the server's database. Each Box's client module, and the stylesheet it
// links, are served from its client folder, and revalidated, since they keep
// their names across builds.
export const createBoxRoutes = () => {
	const app = new Elysia()
		.get("/api/boxes", () => [...installedBoxes().values()].map(({ metadata }) => ({ ...metadata, client: `/boxes/${metadata.id}/client.js` })), { response: boxList })
		.get("/boxes/:box/:file", async ({ params: { box, file }, set, status }) => {
			const folder = boxClientFolder(box);
			const served = folder === undefined || (file !== "client.js" && file !== "client.css") ? undefined : Bun.file(join(folder, file));
			if (served === undefined || !await served.exists()) return status(404, "There is no such Box client file.");
			set.headers["cache-control"] = "no-cache";
			return served;
		});
	for (const routes of boxRoutes()) app.use(routes);
	return app;
};
