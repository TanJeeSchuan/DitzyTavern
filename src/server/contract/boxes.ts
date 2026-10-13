import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Elysia } from "elysia";
import { boxList } from "../../shared/contract/box";
import { boxClientFolder, serverBoxes } from "../box/registry";

// @approved
//  The loaded Boxes, and the routes each Box serves beside the host's,
// mounted under its own `/api/boxes/<id>`. Boxes load before the contract is
// built, so the routes of every loaded Box are mounted. Each Box's client
// module, and the stylesheet it links, are served from its client folder,
// and revalidated, since they keep their names across builds.
export const createBoxRoutes = (database: Database) => {
	const app = new Elysia()
		.get("/api/boxes", () => [...serverBoxes().keys()].map((id) => ({ id, client: `/boxes/${id}/client.js` })), { response: boxList })
		.get("/boxes/:box/:file", async ({ params: { box, file }, set, status }) => {
			const folder = boxClientFolder(box);
			const served = folder === undefined || (file !== "client.js" && file !== "client.css") ? undefined : Bun.file(join(folder, file));
			if (served === undefined || !await served.exists()) return status(404, "There is no such Box client file.");
			set.headers["cache-control"] = "no-cache";
			return served;
		});
	for (const [id, box] of serverBoxes()) {
		const routes = box.routes?.(database);
		if (routes !== undefined) app.use(new Elysia({ prefix: `/api/boxes/${id}` }).use(routes));
	}
	return app;
};
