import type { Database } from "bun:sqlite";
import { Elysia, type AnyElysia } from "elysia";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { boxSeed } from "./seed";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { boxDescriptor, boxReference, installBoxDescriptors, type BoxDescriptor, type BoxId, type BoxSetups, type BoxStates, type PromptBoxReference } from "../../shared/contract/box";
import { assertBoxDescriptor, assertBoxServer, type BoxServerModule } from "../../shared/contract/box-descriptor";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type { BoxValue } from "../../shared/contract/box-value";
import type { RecordStates } from "./records";
import type { BoxMoves } from "../../shared/contract/box-generation";
import type { AdvanceInput, AdvanceResult, BlockItem, BoxContext, BoxServices, CaptureRead, HostBox } from "./contract";
import { resolveDecisionOf, type BoxDecision } from "./services";

// @approved
//  Once each hook has the shape the host calls, the descriptor decides which
// hooks a Box must declare: records for a `record` schema, a digest for a
// `decision`, and a render for `moves`. A digesting Box's window read is the
// host's passage timeline, so it declares no `read`; only that read calls
// `status`, so no other Box declares one. Ids are known only at runtime, so
// the registry checks this when it is built.
const checkedHooks = (id: BoxId, descriptor: BoxDescriptor, box: BoxServerModule): HostBox => {
	const broken = ([
		[(descriptor.record === undefined) === (box.records === undefined), "records exactly when it declares a record"],
		[(descriptor.decision === undefined) === (box.records?.digest === undefined), "a digest exactly when it declares a decision"],
		[(descriptor.moves === undefined) === (box.moves === undefined), "a Move render exactly when it declares Moves"],
		[descriptor.decision === undefined || box.read === undefined, "no read, since it digests"],
		[descriptor.decision !== undefined || box.status === undefined, "no status, since it does not digest"],
	] as const).flatMap(([holds, rule]) => holds ? [] : [rule]);
	if (broken.length > 0) throw new Error(`The ${id} Box must declare ${broken.join("; ")}.`);
	// @approved
	// SAFETY: assertBoxServer checked each hook the host calls is a function; each Box types its own with `satisfies Box<…>`.
	return box as HostBox;
};

// @approved
//  A Box's routes, built for the server's database and mounted under
// `/api/boxes/<id>`, so a factory that throws, returns anything but the
// promised Elysia app, or fails to mount refuses its Box.
const mountedRoutes = (id: BoxId, box: HostBox, database: Database): AnyElysia | undefined => {
	if (box.routes === undefined) return undefined;
	const routes: unknown = box.routes(database);
	if (!(routes instanceof Elysia)) throw new Error(`The ${id} Box's routes must return an Elysia app.`);
	return new Elysia({ prefix: `/api/boxes/${id}` }).use(routes);
};

// @approved
//  A Box folder holds its descriptor in `shared-descriptor.ts` and its server
// module in `server.ts`, each as its default export, and is named for the
// Box's id. Folders load in order, each folder's Boxes by name, so a plugin
// folder listed after the built-in one cannot replace a built-in Box. An
// absent folder holds no Boxes, as before any plugin is installed. A Box
// that fails to load is refused with its reason; the rest still load. The
// server passes the database it serves, and each Box's routes are built and
// mounted for it once, here, so a Box whose routes fail is refused instead of
// stopping the server, and the contract serves the routes mounted.
export const discoverBoxes = async (folders: readonly string[], database?: Database) => {
	const boxes = new Map<BoxId, { readonly descriptor: BoxDescriptor; readonly box: HostBox; readonly folder: string; readonly routes: AnyElysia | undefined }>();
	const refused: { readonly folder: string; readonly reason: string }[] = [];
	for (const parent of folders) {
		const entries = await readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
		for (const name of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
			const folder = join(parent, name);
			try {
				const { default: descriptor }: { default: unknown } = await import(join(folder, "shared-descriptor.ts"));
				assertBoxDescriptor(descriptor);
				if (descriptor.id !== name) throw new Error(`Its folder must be named for its id, ${descriptor.id}.`);
				if (boxes.has(descriptor.id)) throw new Error(`A Box with the id ${descriptor.id} is already loaded.`);
				const { default: box }: { default: unknown } = await import(join(folder, "server.ts"));
				if (box === undefined) throw new Error(`The ${descriptor.id} Box's server.ts has no default export.`);
				assertBoxServer(box);
				const checked = checkedHooks(descriptor.id, descriptor, box);
				boxes.set(descriptor.id, { descriptor, box: checked, folder, routes: database === undefined ? undefined : mountedRoutes(descriptor.id, checked, database) });
			} catch (error) {
				refused.push({ folder, reason: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return { boxes: [...boxes.values()], refused };
};

export const builtInBoxes = join(import.meta.dir, "../../boxes");
/** @approved The built-in Boxes, then the plugins installed in the data folder. */
export const boxFolders = [builtInBoxes, join(process.cwd(), "data", "boxes")];

let registered: ReadonlyMap<BoxId, HostBox> = new Map();
let routes: ReadonlyMap<BoxId, AnyElysia> = new Map();
let clientFolders: ReadonlyMap<BoxId, string> = new Map();
// @approved
//  Builds the registry from `folders` at startup, before anything reads it,
// logging each refused Box. A server passes the database it serves, and loads
// again for each database it opens, since a Box's routes are built for one;
// a caller that mounts no routes passes none.
export const loadBoxes = async (folders: readonly string[] = boxFolders, database?: Database): Promise<void> => {
	const { boxes, refused } = await discoverBoxes(folders, database);
	for (const { folder, reason } of refused) console.error(`[boxes] Refused the Box in ${folder}: ${reason}`);
	installBoxDescriptors(boxes.map(({ descriptor }) => descriptor));
	registered = new Map(boxes.map(({ descriptor, box }) => [descriptor.id, box]));
	routes = new Map(boxes.flatMap(({ descriptor: { id }, routes: built }) => built === undefined ? [] : [[id, built]]));
	clientFolders = new Map(boxes.map(({ descriptor: { id }, folder }) => [id, dirname(folder) === builtInBoxes ? join("dist", "boxes", id) : join(folder, "dist")]));
};

/** @approved Where a loaded Box's built client module is served from: the client build writes a built-in's into `dist/boxes/<id>`, and `box:build` a plugin's into its own `dist`. */
export const boxClientFolder = (id: BoxId): string | undefined => clientFolders.get(id);

// @approved
//  The server module of every loaded Box, by id, in registry order. Each Box
// types its own hooks with `satisfies Box<…>`; the host holds it as a HostBox
// and checks each value it routes against the Box's descriptor.
export const serverBoxes = (): ReadonlyMap<BoxId, HostBox> => registered;
/** @approved The routes each loaded Box serves, built for the database it was loaded with and mounted under its prefix, by id, in registry order. */
export const boxRoutes = (): ReadonlyMap<BoxId, AnyElysia> => routes;
/** @approved A registered Box's server module; an unknown id has none. */
export const serverBox = (id: BoxId): HostBox | undefined => serverBoxes().get(id);

/** @approved What each Box with an enabled preset block contributes to one Generation. */
export type BoxItems = Record<PromptBoxReference, readonly (BlockItem & { readonly index: number })[] | undefined>;

export type BoxResults = Readonly<Record<PromptBoxReference, AdvanceResult<GenerationJsonValue, GenerationJsonValue> | undefined>>;

interface CapturedBox {
	readonly reference: PromptBoxReference;
	readonly fingerprint: string;
	run(services: BoxServicesOf): Promise<AdvanceResult<GenerationJsonValue, GenerationJsonValue>>;
}
export type BoxInputs = readonly CapturedBox[];
/** @approved The host services for each Box, as `boxServices` builds them. */
type BoxServicesOf = (id: BoxId, decision: BoxDecision) => BoxContext<keyof BoxServices>;

/** @approved The services a Box declared in `inject`, and the signal. */
export const injectServices = (box: HostBox, services: BoxContext<keyof BoxServices>): BoxContext<keyof BoxServices> => {
	// @approved
	// SAFETY: The entries are exactly the services this Box declared in inject.
	const injected = Object.fromEntries((box.inject ?? []).map((key) => [key, services[key]])) as Pick<BoxServices, keyof BoxServices>;
	return { ...injected, signal: services.signal };
};

// @approved
//  The Decision Model selection is resolved with the rest of the capture and
// kept in `run`'s closure, so its credential never reaches the capture's
// serialized fields.
const captureBox = (id: BoxId, box: HostBox, input: AdvanceInput<BoxValue, unknown, unknown, unknown>, decision: BoxDecision): CapturedBox => ({
	reference: boxReference(id),
	fingerprint: JSON.stringify({ setup: input.setup, state: input.state, moves: input.moves, dependencies: box.advance?.fingerprint?.(input) ?? input.dependencies }),
	run: async (services) => {
		const result = await box.advance?.run(input, injectServices(box, services(id, decision))) ?? { items: [] };
		if (result.record !== undefined) {
			const { record } = boxDescriptor(id);
			if (record === undefined) throw new Error(`${boxReference(id)} returned a record without declaring records.`);
			Value.Assert(record, result.record);
		}
		if (result.trace !== undefined && box.advance?.trace !== undefined) Value.Assert(box.advance.trace, result.trace);
		return result;
	},
});

// @approved
//  The preset decides where a Box goes; the Chat decides whether it runs. A
// Box is captured only while it is enabled and its block is.
export const captureBoxes = (slots: readonly PromptPresetSlot[], setups: BoxSetups, boxes: BoxStates, states: RecordStates, moves: BoxMoves, read: CaptureRead): BoxInputs =>
	[...serverBoxes()].flatMap(([id, box]) => {
		if (boxes[id] !== "enabled" || !slots.some((slot) => slot.enabled && slot.reference === boxReference(id))) return [];
		const setup = setups[id];
		const dependencies = box.dependencies?.({ ...read, seed: boxSeed(read.seed, id) }, setup);
		return [captureBox(id, box, { setup, state: states[id], moves: moves[id] ?? [], dependencies }, resolveDecisionOf(read.database, id))];
	});

export const fingerprintBoxes = (inputs: BoxInputs): string => JSON.stringify(inputs.map(({ reference, fingerprint }) => [reference, fingerprint]));

export const advanceBoxes = async (inputs: BoxInputs, services: BoxServicesOf): Promise<BoxResults> =>
	Object.fromEntries(await Promise.all(inputs.map(async (box) => [box.reference, await box.run(services)])));
