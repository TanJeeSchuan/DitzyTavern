import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Elysia } from "elysia";
import { Type } from "@sinclair/typebox";
import { boxClientSource, boxRoutes, clearHeldValues, heldBoxValues as held, loadBoxVersion, serverBoxes, type BoxClientSource } from "../box/registry";
import { boxFrameImage, boxFrameResponse, closeBoxFrame, uploadBoxFrameImage } from "../box/frame";
import { boxFrameRoute } from "../../shared/box-frame";
import { boxFrameImageParams, boxFrameParams, boxList, boxVersionListing, boxVersionParams } from "../../shared/contract/box-sandboxed";
import { boxParams as params, heldBoxValues, heldBoxValuesCleared, installedBoxes } from "../../shared/contract/box";
import { imageUploadBody, imageUploadResponse } from "../../shared/contract/image";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";
import { notFoundResponse } from "./responses";
import { presentDomainError } from "./domain-error";
import { recoverActiveGenerations } from "../workflows";
import { revalidatedFile, revalidatedText } from "./content-validators";

const uploadResponse = { 200: imageUploadResponse, 404: notFoundOutcome, 422: invalidOutcome };
/** @approved The request's host as a CSP host-source: its Host header, normalized, or the URL's host when that does not parse. */
const requestHost = (request: Request) => {
	try { return new URL(`http://${request.headers.get("host") ?? ""}`).host; } catch { return new URL(request.url).host; }
};

/** @approved A sandboxed Box's `ui.js` or `ui.css`; an absent `ui.css` is an empty stylesheet. */
const uiText = (source: Extract<BoxClientSource, { kind: "sandboxed" }>, file: string) => file === "ui.js" ? source.ui : file === "ui.css" ? source.css ?? "" : undefined;
const uiType = (file: string) => file === "ui.js" ? "text/javascript;charset=utf-8" : "text/css;charset=utf-8";
/** @approved One version of a versioned Box, loaded on first request; an unknown Box or version has none. */
const versionOf = (box: string, version: string) => loadBoxVersion(box, version).catch(() => undefined);

// @approved
//  The loaded Boxes, and the routes each Box serves beside the host's,
// under its own `/api/boxes/<id>`: the routes the loader built and mounted
// for the server's database. A trusted Box is listed with its client
// module's URL, a sandboxed one with its descriptor, which the client builds
// its surfaces from. Each Box's client files are served from its client
// folder, or for a sandboxed Box from what the loader read or built, and
// revalidated, since they keep their names across builds. A Box's held
// values are listed, and cleared on request, beside it. Every Box frame
// loads its document, its images and its uploads under its own token. A
// versioned Box is listed at its `latest`, with that version's hash; any
// other version a Chat pins is served by its hash, its descriptor for the
// client to build its surfaces from and its `ui.js` and `ui.css` at URLs
// that never change what they answer, so they are cached for good.
export const createBoxRoutes = (database: Database) => {
	const app = new Elysia()
		.get("/api/boxes", () => [...installedBoxes().values()].map(({ metadata }) => {
			const source = boxClientSource(metadata.id);
			const version = serverBoxes().get(metadata.id)?.version;
			return source?.kind === "sandboxed" ? { ...metadata, sandboxed: source.file, ...version !== undefined && { version } } : { ...metadata, client: `/boxes/${metadata.id}/client.js` };
		}), { response: boxList })
		.get("/api/boxes/:box/versions/:version", async ({ params }) => {
			const client = (await versionOf(params.box, params.version))?.client;
			return client?.kind === "sandboxed" ? { sandboxed: client.file } : notFoundResponse();
		}, { params: boxVersionParams, response: { 200: boxVersionListing, 404: notFoundOutcome } })
		.get("/boxes/:box/versions/:version/:file", async ({ params, status }) => {
			const client = (await versionOf(params.box, params.version))?.client;
			const text = client?.kind === "sandboxed" ? uiText(client, params.file) : undefined;
			return text === undefined ? status(404, "There is no such Box client file.")
				: new Response(text, { headers: { "content-type": uiType(params.file), "cache-control": "public, max-age=31536000, immutable" } });
		}, { params: Type.Object({ ...boxVersionParams.properties, file: Type.String() }) })
		.get(`${boxFrameRoute}/:token`, async ({ params: { token }, request }) => await boxFrameResponse(database, token, requestHost(request)) ?? notFoundResponse(),
			{ params: boxFrameParams })
		.delete(`${boxFrameRoute}/:token`, ({ params: { token } }) => { closeBoxFrame(token); return new Response(null, { status: 204 }); }, { params: boxFrameParams })
		.get(`${boxFrameRoute}/:token/images/:hash`, ({ params: { token, hash } }) => boxFrameImage(database, token, hash) ?? notFoundResponse(),
			{ params: boxFrameImageParams })
		.post(`${boxFrameRoute}/:token/images`, async ({ params: { token }, body }) => {
			try {
				return await uploadBoxFrameImage(database, token, Buffer.from(body.data, "base64")) ?? notFoundResponse();
			} catch (error) {
				return presentDomainError(error, uploadResponse);
			}
		}, { params: boxFrameParams, body: imageUploadBody, response: uploadResponse })
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
			if (source?.kind === "sandboxed") {
				const text = uiText(source, file);
				return text === undefined ? status(404, "There is no such Box client file.") : revalidatedText(request, text, { "content-type": uiType(file) });
			}
			const served = source === undefined || (file !== "client.js" && file !== "client.css") ? undefined : Bun.file(join(source.folder, file));
			if (served === undefined || !await served.exists()) return status(404, "There is no such Box client file.");
			return revalidatedFile(request, served);
		});
	for (const routes of boxRoutes()) app.use(routes);
	return app;
};
