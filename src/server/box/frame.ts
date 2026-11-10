import type { Database } from "bun:sqlite";
import { and, count, eq, sum } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { boxFrameRoute } from "../../shared/box-frame";
import { boxImageGrantTable, imageTable } from "../database/schema";
import { readActiveCast } from "../conversation";
import { ingestImage, readImage, storeImage } from "../image";
import { InvalidImageError } from "../image/errors";
import { readBoxLifecycles } from "./setup";
import { readBoxVersions } from "./version-pin";

const client = join(import.meta.dir, "../../client");

// @approved
//  The frame's host script and its stylesheets, built once when the first
// frame is served: the script bundles DOMPurify and the morph, and the
// stylesheets are the host's theme tokens and the frame's base styles,
// inlined because the frame loads nothing.
let parts: Promise<{ readonly script: string; readonly style: string }> | undefined;
const frameParts = () => parts ??= (async () => {
	const build = await Bun.build({ entrypoints: [join(client, "box-windows/frame.ts")], target: "browser", format: "iife", minify: true });
	if (!build.success) throw new AggregateError(build.logs, "The Box frame script did not build.");
	const [script] = build.outputs;
	if (script === undefined) throw new Error("The Box frame script built no output.");
	const styles = await Promise.all([join(client, "../styles/theme.css"), join(client, "box-windows/frame.css")].map((path) => Bun.file(path).text()));
	// @approved
	// An inline script ends at the first `</script`, so the bundle's own are escaped, which leaves every string and regex it holds the same.
	return { script: (await script.text()).replaceAll("</script", "<\\/script"), style: styles.join("\n") };
})();

// @approved
//  Each frame instance the app opens gets its own token, bound here to one
// Box, one Chat, the Box's insertion instance there and the version the
// frame runs: its document, its image URLs and its uploads all name the
// token, so a guest can address no other Box or Chat. The app closes the
// token when it tears the frame down, removing the Box ends the instance,
// and an upgrade moves the Chat off the version, so a token never outlives
// its frame, comes back with a reinserted Box, or writes for a version the
// Chat no longer runs. Tokens live in memory, the oldest dropped past the
// cap.
type FrameBinding = { readonly box: BoxId; readonly conversationId: number; readonly instance: string; readonly version: string | undefined };
const frames = new Map<string, FrameBinding>();
const MAX_FRAMES = 1000;
export const openBoxFrame = (binding: FrameBinding) => {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
	frames.set(token, binding);
	for (const oldest of frames.keys()) if (frames.size > MAX_FRAMES) frames.delete(oldest); else break;
	return token;
};
export const closeBoxFrame = (token: string) => frames.delete(token);
/** @approved The binding of a frame whose Box is still the instance and the version it was opened for in its Chat. */
const frameOf = (db: BunSQLiteDatabase, token: string) => {
	const binding = frames.get(token);
	return binding !== undefined && readBoxLifecycles(db, binding.conversationId)[binding.box]?.instance === binding.instance
		&& readBoxVersions(db, binding.conversationId)[binding.box] === binding.version ? binding : undefined;
};
const imagePath = (token: string) => `${boxFrameRoute}/${token}/images/`;

// @approved
//  The frame document runs only host code: its script carries this response's
// nonce, and the guest's own code runs in a Worker the script starts from a
// blob, under the policy the Worker inherits. Nothing loads from the network
// but this frame's own image path, given with the request's host and no
// scheme so it matches behind a proxy that terminates TLS. Guest CSS is
// inline, and only a page on the frame route's own origin, the app's, may
// embed the frame. `'self'` matches that origin even behind a proxy that
// rewrites Host, as the dev server's does for every route but this one.
export const boxFrameResponse = async (database: Database, token: string, host: string) => {
	if (frameOf(drizzle(database), token) === undefined) return undefined;
	const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
	const { script, style } = await frameParts();
	const policy = ["default-src 'none'", `script-src 'nonce-${nonce}'`, "worker-src blob:", "style-src 'unsafe-inline'", `img-src ${host}${imagePath(token)}`, "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"].join("; ");
	const body = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style><script nonce="${nonce}">${script}</script></head><body></body></html>`;
	return new Response(body, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store", "content-security-policy": policy } });
};

// @approved
//  A frame displays an Image only when the host says its Box owns it: the Box
// uploaded it through a frame, which recorded a grant, or it is the Portrait
// of someone in the frame's Chat's Cast. A hash the Box wrote into its own
// values grants nothing. The answer is never cached, so every load passes
// this check again: a Portrait stops showing once its Participant leaves.
export const boxFrameImage = (database: Database, token: string, hash: string) => {
	const db = drizzle(database);
	const frame = frameOf(db, token);
	if (frame === undefined) return undefined;
	const granted = db.select().from(boxImageGrantTable).where(and(eq(boxImageGrantTable.box_id, frame.box), eq(boxImageGrantTable.hash, hash))).get() !== undefined;
	if (!granted && !readActiveCast(db, frame.conversationId).some(({ portrait }) => portrait?.hash === hash)) return undefined;
	const image = readImage(db, hash);
	return image && new Response(new Uint8Array(image.bytes), { headers: { "content-type": image.media_type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
};

/** @approved The most Images, and image bytes, a Box may hold through its frames' uploads. */
export const BOX_IMAGE_COUNT = 200;
export const BOX_IMAGE_BYTES = 100 * 1024 * 1024;

// @approved
//  An Image a frame's Box uploads, stored as any upload is and granted to that
// Box, while the Box's granted Images stay within its quota: an upload that
// would pass the count or the byte total is refused before it is stored. The
// check, the frame's validity and the write happen in one transaction after
// the image is ingested, so concurrent uploads from the Box's other frames
// cannot both pass it, and a frame closed during ingestion stores nothing.
export const uploadBoxFrameImage = async (database: Database, token: string, bytes: Uint8Array) => {
	if (frameOf(drizzle(database), token) === undefined) return undefined;
	const image = await ingestImage(bytes);
	return database.transaction(() => {
		const db = drizzle(database);
		const frame = frameOf(db, token);
		if (frame === undefined) return undefined;
		const granted = db.select().from(boxImageGrantTable).where(and(eq(boxImageGrantTable.box_id, frame.box), eq(boxImageGrantTable.hash, image.hash))).get() !== undefined;
		const held = db.select({ count: count(), bytes: sum(imageTable.byte_size).mapWith(Number) }).from(boxImageGrantTable)
			.innerJoin(imageTable, eq(imageTable.hash, boxImageGrantTable.hash)).where(eq(boxImageGrantTable.box_id, frame.box)).get();
		if (!granted && ((held?.count ?? 0) >= BOX_IMAGE_COUNT || (held?.bytes ?? 0) + image.bytes.byteLength > BOX_IMAGE_BYTES)) {
			throw new InvalidImageError(`The ${frame.box} Box already holds its ${BOX_IMAGE_COUNT} images or ${BOX_IMAGE_BYTES / 1024 / 1024} MiB of uploads.`);
		}
		storeImage(database, image);
		db.insert(boxImageGrantTable).values({ box_id: frame.box, hash: image.hash }).onConflictDoNothing().run();
		return { hash: image.hash };
	}).immediate();
};
