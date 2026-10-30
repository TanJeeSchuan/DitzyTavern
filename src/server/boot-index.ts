import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { boxClientFolder } from "./box/registry";
import { activeChatId } from "./conversation";
import { installedBoxes } from "../shared/contract/box";

const link = (rel: string, href: string, as = "") => `<link rel="${rel}" href="${href}"${as === "" ? "" : ` as="${as}"`}${as === "style" ? "" : " crossorigin"}>`;

// @approved
//  The page names what the first render reads, so the browser fetches it
// while the entry downloads instead of each read waiting on the one before:
// the Box list, then every Box module and stylesheet, then the workspace, then
// the active Chat. A preload the client's own request matches by URL is
// consumed by it; each URL here is the one its reader requests, and only a
// stylesheet, which a Box links without CORS, is preloaded without it.
const bootReads = (database: Database) => {
	const boxes = [...installedBoxes().keys()].flatMap((id) => {
		const folder = boxClientFolder(id);
		return [
			link("modulepreload", `/boxes/${id}/client.js`),
			...folder !== undefined && existsSync(join(folder, "client.css")) ? [link("preload", `/boxes/${id}/client.css`, "style")] : [],
		];
	});
	const chat = activeChatId(database);
	const reads = ["/api/boxes", "/api/workspace", "/api/connection-settings", "/api/connection-settings/presets",
		...chat === null ? [] : [`/api/conversations/${chat}`, `/api/conversations/${chat}/history?page=1`, `/api/conversations/${chat}/generation-settings`]];
	return [...boxes, ...reads.map((href) => link("preload", href, "fetch"))].join("");
};

export const bootIndex = async (database: Database) =>
	(await Bun.file("dist/index.html").text()).replace("</head>", `${bootReads(database)}</head>`);
