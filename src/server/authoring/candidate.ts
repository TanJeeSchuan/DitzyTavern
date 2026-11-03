import { Value } from "@sinclair/typebox/value";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { authoredDescriptor } from "../../shared/contract/authoring";
import { replaceFile } from "../box/sandboxed-folder";

/** @approved The files a candidate's write tools set, each with the most bytes one write may hold. Packages, the lock and bundles are only written by the host's build. */
export const AUTHORED_FILES = { "descriptor.json": 64 * 1024, "logic.js": 512 * 1024, "ui.js": 512 * 1024, "ui.css": 64 * 1024 } as const;
export type AuthoredFile = keyof typeof AUTHORED_FILES;

/** @approved Where candidates live, outside the plugin folder, so no candidate is ever discovered as a plugin. */
export const defaultAuthoringFolder = (): string => join(process.cwd(), "data", "authoring");

// @approved
//  One authoring session's candidate: a folder the host creates at
// `<root>/<session>/<id>/`, named for the Box id the host chose, so the agent
// names no path and no id. Its writes set one fixed file's content, refused
// past that file's cap before anything is written: the cap is checked on the
// agent's text and again on the exact text written, and `descriptor.json` is
// written compactly with the candidate's id. Writes and checks take turns:
// a check (a scenario or Install) holds the candidate until it ends, so it
// reads, builds and publishes bytes no write can change under it. Work whose
// signal aborted while it waited is dropped when its turn comes, and
// `remove` waits behind whatever is in flight.
export const createCandidate = async (root: string) => {
	const session = crypto.randomUUID();
	const id = `authored-${crypto.randomUUID().slice(0, 8)}`;
	const folder = join(root, session, id);
	await mkdir(folder, { recursive: true });
	let queue: Promise<unknown> = Promise.resolve();
	const exclusive = <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
		const next = queue.then(() => {
			signal?.throwIfAborted();
			return run();
		});
		queue = next.catch(() => undefined);
		return next;
	};
	const capped = (file: AuthoredFile, text: string) => {
		const bytes = Buffer.byteLength(text);
		if (bytes > AUTHORED_FILES[file]) throw new Error(`${file} may hold at most ${AUTHORED_FILES[file] / 1024} KiB; this is ${Math.ceil(bytes / 1024)} KiB.`);
		return bytes;
	};
	const write = (file: AuthoredFile, content: string, signal?: AbortSignal) => {
		capped(file, content);
		const text = file === "descriptor.json" ? withId(content, id) : content;
		const bytes = capped(file, text);
		return exclusive(async () => {
			await replaceFile(join(folder, file), text);
			return { written: file, bytes };
		}, signal);
	};
	return { session, id, folder, write, check: exclusive, remove: () => exclusive(() => rm(join(root, session), { recursive: true, force: true })) };
};
export type Candidate = Awaited<ReturnType<typeof createCandidate>>;

/** @approved A descriptor's JSON with the candidate's id in place of any the agent wrote. */
const withId = (content: string, id: string) => {
	let parsed: unknown;
	try { parsed = JSON.parse(content); } catch (error) { throw new Error(`descriptor.json is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
	if (!Value.Check(authoredDescriptor, parsed)) throw new Error("descriptor.json must be one JSON object.");
	return JSON.stringify({ ...parsed, id });
};

/** @approved Removes every candidate a stopped server left behind; sessions live in memory, so none survives a restart. */
export const sweepCandidates = (root: string) => rm(root, { recursive: true, force: true });
