import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { boxList } from "../../shared/contract/box";
import { serverBoxes } from "../box/registry";

// @approved
//  The loaded Boxes, and the routes each Box serves beside the host's,
// mounted under its own `/api/boxes/<id>`. Boxes load before the contract is
// built, so the routes of every loaded Box are mounted.
export const createBoxRoutes = (database: Database) => {
	const app = new Elysia().get("/api/boxes", () => [...serverBoxes().keys()].map((id) => ({ id, client: `/boxes/${id}/client.js` })), { response: boxList });
	for (const [id, box] of serverBoxes()) {
		const routes = box.routes?.(database);
		if (routes !== undefined) app.use(new Elysia({ prefix: `/api/boxes/${id}` }).use(routes));
	}
	return app;
};
