import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { boxFrameRoute } from "../../shared/box-frame";
import { boxImageGrantTable } from "../database/schema";
import { readActiveCast } from "../conversation";
import { readImage, uploadImage } from "../image";
import { readBoxLifecycles } from "./setup";

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
// Box and one Chat: its document, its image URLs and its uploads all name
// the token, so a guest can address no other Box or Chat. Tokens live in
// memory, the oldest dropped past the cap.
type FrameBinding = { readonly box: BoxId; readonly conversationId: number };
const frames = new Map<string, FrameBinding>();
const MAX_FRAMES = 1000;
export const openBoxFrame = (binding: FrameBinding) => {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
	frames.set(token, binding);
	for (const oldest of frames.keys()) if (frames.size > MAX_FRAMES) frames.delete(oldest); else break;
	return token;
};
/** @approved The binding of a frame whose Box is still present in its Chat. */
const frameOf = (db: BunSQLiteDatabase, token: string) => {
	const binding = frames.get(token);
	return binding !== undefined && readBoxLifecycles(db, binding.conversationId)[binding.box] !== undefined ? binding : undefined;
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
// values grants nothing.
export const boxFrameImage = (database: Database, token: string, hash: string) => {
	const db = drizzle(database);
	const frame = frameOf(db, token);
	if (frame === undefined) return undefined;
	const granted = db.select().from(boxImageGrantTable).where(and(eq(boxImageGrantTable.box_id, frame.box), eq(boxImageGrantTable.hash, hash))).get() !== undefined;
	if (!granted && !readActiveCast(db, frame.conversationId).some(({ portrait }) => portrait?.portrait_hash === hash)) return undefined;
	const image = readImage(db, hash);
	return image && new Response(new Uint8Array(image.bytes), { headers: { "content-type": image.media_type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
};

/** @approved An Image a frame's Box uploads, stored as any upload is and granted to that Box. */
export const uploadBoxFrameImage = async (database: Database, token: string, bytes: Uint8Array) => {
	const frame = frameOf(drizzle(database), token);
	if (frame === undefined) return undefined;
	const { hash } = await uploadImage(database, bytes);
	drizzle(database).insert(boxImageGrantTable).values({ box_id: frame.box, hash }).onConflictDoNothing().run();
	return { hash };
};
