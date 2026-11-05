import type { Database } from "bun:sqlite";
import { Elysia, type AnyElysia } from "elysia";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BoxLifecycles } from "./setup";
import { boxSeed } from "./seed";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { boxMetadataFrom, boxReference, installBoxes, type BoxDescriptor, type BoxId, type BoxSetups, type PromptBoxReference } from "../../shared/contract/box";
import { assertBoxDescriptor, assertBoxServer, assertChecked, boxHookOutputs, type BoxServerModule } from "../../shared/contract/box-descriptor";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type { BoxValue } from "../../shared/contract/box-value";
import type { BoxFolds } from "./records";
import type { BoxMoves } from "../../shared/contract/box-generation";
import type { AdvanceInput, AdvanceResult, BlockItem, BoxContext, CaptureMessage, CaptureRead, DigestContext, DigestWindow, HostBox } from "./contract";
import { decisionIdentity, resolveDecisionOf, type BoxDecision } from "./services";
import { checkStoredBoxValues, clearHeldBoxValues } from "./schema-check";
import { sandboxedBox } from "./sandboxed";
import { sandboxedSources } from "./sandboxed-build";
import { esmOrigin } from "./sandboxed-deps";
import { sandboxedFolder } from "./sandboxed-folder";
import { sandboxedDescriptor, sandboxedDescriptorFile, type SandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import { readBoxVersions } from "./version-pin";
import { assertPlainHome, isVersioned, readLatest, VERSION_PATTERN, versionFolder } from "./versions";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

// @approved
//  Once each hook has the shape the host calls, the descriptor decides which
// hooks a Box must declare: records for a `record` schema, a digest for a
// `decision`, and a render for `moves`. A digesting Box's window read is the
// host's passage timeline, so it declares no `read`; only that read calls
// `status`, so no other Box declares one. Ids are known only at runtime, so
// the registry checks this when it is built. The Box the host holds checks
// each hook's output against `boxHookOutputs` where the hook returns it, and
// names the Box, the hook and the failing path when it does not pass.
const checkedHooks = (id: BoxId, descriptor: BoxDescriptor, box: BoxServerModule): HostBox => {
	const outputs = boxHookOutputs(descriptor, box.advance?.trace);
	assertChecked(outputs["records.initial"], box.records?.initial, `The ${id} Box's records.initial`);
	const broken = ([
		[(descriptor.record === undefined) === (box.records === undefined), "records exactly when it declares a record"],
		[box.records === undefined || ("initial" in box.records) === (box.records.fold !== undefined), "a fold exactly when it declares an initial state"],
		[(descriptor.decision === undefined) === (box.records?.digest === undefined), "a digest exactly when it declares a decision"],
		[(descriptor.moves === undefined) === (box.moves === undefined), "a Move render exactly when it declares Moves"],
		[descriptor.decision === undefined || box.read === undefined, "no read, since it digests"],
		[descriptor.decision !== undefined || box.status === undefined, "no status, since it does not digest"],
	] as const).flatMap(([holds, rule]) => holds ? [] : [rule]);
	if (broken.length > 0) throw new Error(`The ${id} Box must declare ${broken.join("; ")}.`);
	// @approved
	// SAFETY: assertBoxServer checked each hook the host calls is a function; each Box types its own with `satisfies Box<…>`.
	const host = box as HostBox;
	// @approved
	//  Every hook runs on the object that declares it: a top-level hook on the
	// module, a nested one on its `moves`, `records`, digest or `advance`.
	const setupError = host.setupError?.bind(host);
	const dependencies = host.dependencies?.bind(host);
	const status = host.status?.bind(host);
	const importSillyTavernNote = host.importSillyTavernNote?.bind(host);
	const { moves, records, advance } = host;
	const checked = <Output>(hook: keyof typeof outputs, output: Output): Output => {
		assertChecked(outputs[hook], output, `The ${id} Box's ${hook} result`);
		return output;
	};
	const digest = records?.digest;
	const checkedDigest = digest && { window: digest.window, run: async (window: DigestWindow, ctx: DigestContext) => checked("records.digest.run", await digest.run(window, ctx)) };
	return {
		setupError: setupError && ((setup, previous) => checked("setupError", setupError(setup, previous))),
		moves: moves && { render: (move, author) => checked("moves.render", moves.render(move, author)) },
		dependencies: dependencies && advance?.fingerprint === undefined ? (read, setup) => checked("dependencies", dependencies(read, setup)) : dependencies,
		records: records && (records.fold === undefined ? { digest: checkedDigest } : {
			initial: records.initial,
			fold: (state, record, setup) => checked("records.fold", records.fold(state, record, setup)),
			foldAll: records.foldAll && ((state, list, setup) => checked("records.fold", records.foldAll!(state, list, setup))), // @approved Checked just before.
			digest: checkedDigest,
		}),
		advance: advance && {
			trace: advance.trace,
			run: async (input, ctx) => checked("advance.run", await advance.run(input, ctx)),
			fingerprint: advance.fingerprint?.bind(advance),
		},
		status: status && ((setup, state) => checked("status", status(setup, state))),
		importSillyTavernNote: importSillyTavernNote && ((note) => checked("importSillyTavernNote", importSillyTavernNote(note))),
		read: host.read?.bind(host),
		routes: host.routes?.bind(host),
		upgrade: host.upgrade?.bind(host),
	};
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

/** @approved Where a Box's client comes from: a trusted Box's built module, or a sandboxed Box's `descriptor.json` and the `ui.js` and `ui.css` the loader read or built; a Box whose window is the passage timeline has no `ui.js`. */
export type BoxClientSource = { readonly kind: "module"; readonly folder: string } | { readonly kind: "sandboxed"; readonly file: SandboxedDescriptorFile; readonly ui: string | undefined; readonly css: string | undefined };

// @approved
//  A built-in sandboxed Box is our own TypeScript, so its `logic.ts` and
// `ui.ts` are bundled at load with the repository's own resolution and
// packages, in development, production and Docker alike, into the one-file
// `logic.js` module and `ui.js` script a plugin ships. Nothing is written, so
// no build output can go stale.
const bundled = async (folder: string, name: "logic" | "ui") => {
	const build = await Bun.build({ entrypoints: [join(folder, `${name}.ts`)], target: "browser", format: name === "logic" ? "esm" : "iife", minify: true });
	if (!build.success) throw new AggregateError(build.logs, `Its ${name}.ts did not build.`);
	const [output] = build.outputs;
	if (output === undefined) throw new Error(`Its ${name}.ts built no output.`);
	return await output.text();
};

/** @approved Refuses a descriptor whose id is not its folder's name, or is already loaded. */
const named = (descriptor: BoxDescriptor, name: string, seen: ReadonlySet<BoxId>) => {
	if (descriptor.id !== name) throw new Error(`Its folder must be named for its id, ${descriptor.id}.`);
	if (seen.has(descriptor.id)) throw new Error(`A Box with the id ${descriptor.id} is already loaded.`);
	return descriptor;
};

/** @approved A sandboxed Box's `descriptor.json`, checked as a file and as a descriptor, and named for its folder. */
const sandboxedDescriptorOf = (text: string | undefined, name: string, seen: ReadonlySet<BoxId>) => {
	if (text === undefined) throw new Error("It has no descriptor.json.");
	const file: unknown = JSON.parse(text);
	assertChecked(sandboxedDescriptorFile, file, "Its descriptor.json");
	return { file, descriptor: named(sandboxedDescriptor(file), name, seen) };
};

/** @approved A sandboxed Box's logic evaluated in its runtime behind checked hooks; a check that fails frees the runtime. */
const sandboxedLoaded = async (descriptor: BoxDescriptor, file: SandboxedDescriptorFile, logic: string, ui: string | undefined, css: string | undefined) => {
	const { box, guestRead, dispose } = await sandboxedBox(descriptor.id, logic);
	try {
		assertBoxServer(box);
		return { descriptor, box: checkedHooks(descriptor.id, descriptor, box), guestRead, client: { kind: "sandboxed", file, ui, css } as const, dispose };
	} catch (error) {
		dispose();
		throw error;
	}
};

// @approved
//  How a sandboxed plugin's folder loads, the one path every caller takes:
// the walk and its snapshot, the descriptor, the confined build of its
// sources, then its logic behind the checked hooks. The loader runs it for
// each plugin folder, and Creator Mode for each scenario and Install, so a
// candidate passes exactly the checks a plugin does. `signal` stops a
// check whose caller gave up, its package fetches included. The caller owns
// the returned runtime and frees it with `dispose`.
export const checkSandboxedFolder = async (folder: string, name: string, seen: ReadonlySet<BoxId>, signal?: AbortSignal) => {
	const files = await sandboxedFolder(folder, name);
	const { file, descriptor } = sandboxedDescriptorOf(files.get("descriptor.json"), name, seen);
	const { logic, ui } = await sandboxedSources(folder, descriptor.id, file.window.kind !== "digest", files, file.dependencies, esmOrigin, signal);
	signal?.throwIfAborted();
	return await sandboxedLoaded(descriptor, file, logic, ui, files.get("ui.css"));
};
export type CheckedSandboxedBox = Awaited<ReturnType<typeof checkSandboxedFolder>>;

// @approved
//  A trusted Box folder holds its descriptor in `shared-descriptor.ts` and
// its server module in `server.ts`, each as its default export; a sandboxed
// one holds `descriptor.json`, `logic.js` and `ui.js`, or, built in, the
// `logic.ts` and `ui.ts` they are bundled from; one whose window is the
// host's passage timeline has no `ui.js`. A folder holding both
// `server.ts` and sandboxed logic is refused, so a folder the app writes
// sandboxed files into never runs as trusted. Either kind is named for the
// Box's id. A plugin folder holding `versions/` is a versioned Box, which
// loads the version its `latest` names, and nothing before its first
// Install.
const loadFolder = async (folder: string, name: string, seen: ReadonlySet<BoxId>) => {
	const builtIn = dirname(folder) === builtInBoxes;
	if (!builtIn && isVersioned(folder)) {
		const version = await readLatest(folder);
		return version === undefined ? undefined : { ...await checkSandboxedFolder(versionFolder(folder, version), name, seen), version, home: folder };
	}
	const typed = builtIn && existsSync(join(folder, "logic.ts"));
	const sandboxed = typed || existsSync(join(folder, "logic.js"));
	if (sandboxed && existsSync(join(folder, "server.ts"))) throw new Error("It holds both server.ts and sandboxed logic; a Box folder is trusted or sandboxed, not both.");
	const unversioned = { version: undefined, home: undefined };
	if (!sandboxed) {
		const { default: imported }: { default: unknown } = await import(join(folder, "shared-descriptor.ts"));
		assertBoxDescriptor(imported);
		const descriptor = named(imported, name, seen);
		const { default: box }: { default: unknown } = await import(join(folder, "server.ts"));
		if (box === undefined) throw new Error(`The ${descriptor.id} Box's server.ts has no default export.`);
		const client = { kind: "module", folder: builtIn ? join("dist", "boxes", descriptor.id) : join(folder, "dist") } as const;
		assertBoxServer(box);
		return { descriptor, box: checkedHooks(descriptor.id, descriptor, box), client, dispose: undefined, ...unversioned };
	}
	if (!typed) return { ...await checkSandboxedFolder(folder, name, seen), ...unversioned };
	const read = (path: string) => Bun.file(join(folder, path)).text().catch(() => undefined);
	const { file, descriptor } = sandboxedDescriptorOf(await read("descriptor.json"), name, seen);
	const withUi = file.window.kind !== "digest";
	return { ...await sandboxedLoaded(descriptor, file, await bundled(folder, "logic"), withUi ? await bundled(folder, "ui") : undefined, await read("ui.css")), ...unversioned };
};

// @approved
//  Folders load in order, each folder's Boxes by name, so a plugin folder
// listed after the built-in one cannot replace a built-in Box. An absent
// folder holds no Boxes, as before any plugin is installed. A Box that fails
// to load is refused with its reason; the rest still load. The server passes
// the database it serves, and each Box's routes are built and mounted for it
// once, here, so a Box whose routes fail is refused instead of stopping the
// server, and the contract serves the routes mounted.
export const discoverBoxes = async (folders: readonly string[], database?: Database) => {
	const boxes = new Map<BoxId, LoadedBox & { readonly home: string | undefined }>();
	const refused: { readonly folder: string; readonly reason: string }[] = [];
	for (const parent of folders) {
		const entries = await readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
		for (const name of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
			const folder = join(parent, name);
			let dispose: (() => void) | undefined;
			try {
				const found = await loadFolder(folder, name, new Set(boxes.keys()));
				if (found === undefined) continue;
				const { descriptor, box, client, version, home } = found;
				dispose = found.dispose;
				boxes.set(descriptor.id, { descriptor, box, client, dispose, version, home, routes: database === undefined ? undefined : mountedRoutes(descriptor.id, box, database) });
			} catch (error) {
				dispose?.();
				refused.push({ folder, reason: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return { boxes: [...boxes.values()], refused };
};

export const builtInBoxes = join(import.meta.dir, "../../boxes");
/** @approved The built-in Boxes, then the plugins installed in the data folder. */
export const boxFolders = [builtInBoxes, join(process.cwd(), "data", "boxes")];

// @approved
//  A loaded Box version as the server holds it: its descriptor, its checked
// hooks, its mounted routes, where its client comes from, how to free a
// sandboxed runtime, and, for a versioned Box, the version's hash.
export type LoadedBox = { readonly descriptor: BoxDescriptor; readonly box: HostBox; readonly routes: AnyElysia | undefined; readonly client: BoxClientSource; readonly dispose: (() => void) | undefined; readonly version: string | undefined };
// @approved
//  The catalog: each loaded Box by id in registry order, a versioned Box by
// its `latest`. Every version of a versioned Box loaded since startup is held
// by `<id>@<hash>`, `latest` included, and none is freed before the next
// load: queued digests and history keep naming the versions they need.
let loaded: ReadonlyMap<BoxId, LoadedBox> = new Map();
let versions = new Map<string, LoadedBox>();
let homes = new Map<BoxId, string>();
const loading = new Map<string, Promise<LoadedBox>>();
let held = new Map<BoxId, readonly string[]>();
const versionKey = (id: BoxId, version: string) => `${id}@${version}`;
/** @approved Installs the shared registry from the loaded catalog, which it mirrors. */
export const installCatalog = () => installBoxes([...loaded.values()].map(({ descriptor }) => ({ metadata: boxMetadataFrom(descriptor), descriptor })));
// @approved
//  Builds the registry from `folders` at startup, before anything reads it,
// logging each refused Box. A server passes the database it serves, and loads
// again for each database it opens, since a Box's routes are built for one;
// a caller that mounts no routes passes none. The client build writes a
// built-in's client module into `dist/boxes/<id>`, and `box:build` a plugin's
// into its own `dist`. With a database, each unversioned Box's stored values
// are checked against its schemas before anything reads them; a versioned
// Box's Chats each pin the version that reads them, and move only through
// the upgrade check. Loading again frees the sandboxed runtimes the previous
// load held.
export const loadBoxes = async (folders: readonly string[] = boxFolders, database?: Database): Promise<void> => {
	const { boxes, refused } = await discoverBoxes(folders, database);
	for (const { folder, reason } of refused) console.error(`[boxes] Refused the Box in ${folder}: ${reason}`);
	for (const { dispose } of new Set([...loaded.values(), ...versions.values()])) dispose?.();
	const entries = boxes.map(({ descriptor, box, client, dispose, version, routes }): LoadedBox => ({ descriptor, box, client, dispose, version, routes }));
	loaded = new Map(entries.map((box) => [box.descriptor.id, box]));
	versions = new Map(entries.flatMap((box) => box.version === undefined ? [] : [[versionKey(box.descriptor.id, box.version), box]]));
	homes = new Map(boxes.flatMap(({ descriptor, home }) => home === undefined ? [] : [[descriptor.id, home]]));
	installCatalog();
	const unversioned = boxes.filter(({ version }) => version === undefined).map(({ descriptor, box }) => ({ id: descriptor.id, descriptor, box }));
	held = database === undefined ? new Map() : new Map(checkStoredBoxValues(database, unversioned));
	for (const [id, places] of held) console.error(`[boxes] The ${id} Box holds ${places.length} stored values its schemas no longer accept, first at ${places[0]}.`);
};

/** @approved The ids of every loaded Box that is not versioned, which no candidate may take. */
export const unversionedBoxIds = (): ReadonlySet<BoxId> => new Set([...loaded].flatMap(([id, { version }]) => version === undefined ? [id] : []));

// @approved
//  Makes a checked version of a versioned Box its `latest` in the running
// registry: the catalog lists it in the Box's place, or after every loaded
// Box for a new one, and new insertions pin it. Every loaded version keeps
// its hooks and its runtime, so Chats pinned to an earlier one are
// unchanged. A version already loaded keeps its runtime and the new one is
// freed. A sandboxed Box has no routes, so none are mounted.
export const installVersion = (id: BoxId, home: string, version: string, checked: CheckedSandboxedBox): void => {
	const key = versionKey(id, version);
	const { descriptor, box, client, dispose } = checked;
	const entry = versions.get(key) ?? { descriptor, box, client, dispose, version, routes: undefined };
	if (entry.box !== box) dispose();
	versions.set(key, entry);
	homes.set(id, home);
	loaded = new Map(loaded.has(id) ? [...loaded].map(([listed, box]) => [listed, listed === id ? entry : box]) : [...loaded, [id, entry]]);
	installCatalog();
};

// @approved
//  Loads one version of a versioned Box the first time anything needs it: a
// Chat that pins it opens or generates, or an upgrade checks it. Concurrent
// callers share one load, and the version stays loaded until the next load.
export const loadBoxVersion = (id: BoxId, version: string): Promise<LoadedBox> => {
	const key = versionKey(id, version);
	const ready = versions.get(key);
	if (ready !== undefined) return Promise.resolve(ready);
	const home = homes.get(id);
	if (home === undefined || !VERSION_PATTERN.test(version)) return Promise.reject(new Error(`The ${id} Box has no version ${version}.`));
	const pending = loading.get(key) ?? (async () => {
		await assertPlainHome(home);
		const checked = await checkSandboxedFolder(versionFolder(home, version), id, unversionedBoxIds());
		const entry = { descriptor: checked.descriptor, box: checked.box, client: checked.client, dispose: checked.dispose, version, routes: undefined };
		versions.set(key, entry);
		return entry;
	})().finally(() => loading.delete(key));
	loading.set(key, pending);
	return pending;
};

/** @approved Loads every version a Chat pins, before anything resolves that Chat's Boxes. */
export const loadChatVersions = async (database: Database, conversationId: number): Promise<void> => {
	await Promise.all(Object.entries(readBoxVersions(drizzle(database), conversationId)).filter(([id]) => homes.has(id)).map(([id, version]) => loadBoxVersion(id, version)));
};

/** @approved One loaded version of a Box: `undefined` names an unversioned Box's only one, or the catalog's for a Chat that pins none. */
export const boxAt = (id: BoxId, version: string | undefined): LoadedBox | undefined => version === undefined ? loaded.get(id) : versions.get(versionKey(id, version));

/** @approved Each catalog Box as one Chat resolves it, in registry order. */
export type ChatBoxes = ReadonlyMap<BoxId, LoadedBox>;
// @approved
//  Every loaded Box as this Chat runs it: a versioned Box at the version the
// Chat pins, or at `latest` when it pins none, and any other Box as loaded.
// A pinned version must be loaded first, and one that is not throws, so no
// lookup silently reads `latest` for a Chat on another version.
export const chatBoxes = (db: BunSQLiteDatabase, conversationId: number): ChatBoxes => {
	const pins = readBoxVersions(db, conversationId);
	return new Map([...loaded].map(([id, latest]) => {
		const pin = pins[id];
		if (pin === undefined || latest.version === undefined || pin === latest.version) return [id, latest];
		const pinned = versions.get(versionKey(id, pin));
		if (pinned === undefined) throw new Error(`The ${id} Box's version ${pin} is not loaded.`);
		return [id, pinned];
	}));
};
/** @approved One Box as this Chat runs it; an unknown id has none. */
export const chatBox = (db: BunSQLiteDatabase, conversationId: number, id: BoxId): LoadedBox | undefined => chatBoxes(db, conversationId).get(id);

/** @approved Each loaded Box's stored values that fail its schemas and did not upgrade, by place, until they are cleared. */
export const heldBoxValues = (): ReadonlyMap<BoxId, readonly string[]> => held;

/** @approved Deletes a loaded Box's held values; returns the Chats whose setup it deleted. */
export const clearHeldValues = (database: Database, id: BoxId): readonly number[] => {
	const box = loaded.get(id);
	if (box === undefined) throw new Error(`There is no loaded Box ${id}.`);
	const setupsCleared = clearHeldBoxValues(database, { id, descriptor: box.descriptor, box: box.box });
	held.delete(id);
	return setupsCleared;
};

/** @approved Where a catalog Box's client comes from. */
export const boxClientSource = (id: BoxId): BoxClientSource | undefined => loaded.get(id)?.client;

// @approved
//  The catalog, by id, in registry order: each Box's `latest`, for what a Box
// is before any Chat holds it.
export const serverBoxes = (): ReadonlyMap<BoxId, LoadedBox> => loaded;
/** @approved The routes each loaded Box serves, built for the database it was loaded with and mounted under its prefix, in registry order. */
export const boxRoutes = (): AnyElysia[] => [...loaded.values()].flatMap(({ routes }) => routes ?? []);

/** @approved What each Box with an enabled preset block contributes to one Generation. */
export type BoxItems = Record<PromptBoxReference, readonly (BlockItem & { readonly index: number })[] | undefined>;

/** @approved What each captured Box returned, and whether the version that ran declares `alwaysRender`. */
export type BoxResults = Readonly<Record<PromptBoxReference, (AdvanceResult<GenerationJsonValue, GenerationJsonValue> & { readonly alwaysRender?: true }) | undefined>>;

interface CapturedBox {
	readonly id: BoxId;
	readonly instance: string;
	readonly version: string | undefined;
	readonly alwaysRender: boolean;
	readonly reference: PromptBoxReference;
	readonly fingerprint: string;
	run(services: BoxContextOf): Promise<AdvanceResult<GenerationJsonValue, GenerationJsonValue>>;
}
export type BoxInputs = readonly CapturedBox[];
/** @approved The context for each Box, as `boxServices` builds it. */
type BoxContextOf = (id: BoxId, decision: BoxDecision) => BoxContext;

// @approved
//  The Decision Model selection is resolved with the rest of the capture and
// kept in `run`'s closure, so its credential never reaches the capture's
// serialized fields; the fingerprint holds its identity, so a changed
// selection marks a preview stale.
const captureBox = (id: BoxId, { instance, version, box, descriptor }: ParticipatingBox, input: AdvanceInput<BoxValue | undefined, unknown, GenerationJsonValue | undefined, unknown>, decision: BoxDecision): CapturedBox => ({
	id, instance, version, alwaysRender: descriptor.alwaysRender === true,
	reference: boxReference(id),
	fingerprint: JSON.stringify({ setup: input.setup, state: input.state, moves: input.moves, dependencies: box.advance?.fingerprint?.(input) ?? input.dependencies, decision: decisionIdentity(decision) }),
	run: async (services) => await box.advance?.run(input, services(id, decision)) ?? { items: [] },
});

/** @approved A Box one Generation captures: the version its Chat runs and the instance it was inserted as. */
export type ParticipatingBox = LoadedBox & { readonly instance: string };
/** @approved The Boxes enabled in both the Chat and its preset, as the Chat runs them, selected once for record folding and capture. */
export const participatingBoxes = (boxes: ChatBoxes, slots: readonly PromptPresetSlot[], lifecycles: BoxLifecycles): ReadonlyMap<BoxId, ParticipatingBox> =>
	new Map([...boxes].flatMap(([id, loaded]) => {
		const lifecycle = lifecycles[id];
		return lifecycle?.state === "enabled" && slots.some((slot) => slot.enabled && slot.reference === boxReference(id)) ? [[id, { ...loaded, instance: lifecycle.instance }]] : [];
	}));

/** @approved What the host read for one Generation, before each Box's own record slots join its messages. */
type HostCaptureRead = Omit<CaptureRead, "messages"> & { readonly messages: readonly Omit<CaptureMessage, "slot">[] };

export const captureBoxes = (boxes: ReturnType<typeof participatingBoxes>, setups: BoxSetups, folds: BoxFolds, moves: BoxMoves, read: HostCaptureRead): BoxInputs =>
	[...boxes].map(([id, participating]) => {
		const setup = setups[id];
		const fold = folds[id];
		const messages = read.messages.map((message) => ({ ...message, slot: fold?.slots.get(message.variantId) }));
		const dependencies = participating.box.dependencies?.({ ...read, seed: boxSeed(read.seed, id), messages }, setup);
		return captureBox(id, participating, { setup, state: fold?.state, moves: moves[id] ?? [], dependencies }, resolveDecisionOf(read.database, id, participating.descriptor));
	});

/** @approved The preview fingerprint of the captured Boxes: each one's version and instance with its inputs, so a preview made under one version is stale under another. */
export const fingerprintBoxes = (inputs: BoxInputs): string => JSON.stringify(inputs.map(({ reference, version, instance, fingerprint }) => [reference, version ?? null, instance, fingerprint]));

export const advanceBoxes = async (inputs: BoxInputs, services: BoxContextOf): Promise<BoxResults> =>
	Object.fromEntries(await Promise.all(inputs.map(async (box) => [box.reference, { ...await box.run(services), ...box.alwaysRender && { alwaysRender: true as const } }])));
