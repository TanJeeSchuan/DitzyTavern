import type { LucideIcon } from "lucide-react";
import type { Static } from "@sinclair/typebox";
import { createContext, type ComponentType } from "react";
import type { BoxLens } from "./lens";
import { sandboxedClient } from "./BoxFrame";
import { boxList, boxVersionListing } from "../../shared/contract/box-sandboxed";
import type { CastParticipant, ConversationSummary } from "../conversation";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import type { BoxMoves, BoxTrace } from "../../shared/contract/box-generation";
import { boxDescriptors, boxMetadataFrom, boxReference, installBoxes, type BoxDescriptor, type BoxId, type BoxMetadata, type BoxStates, type PromptBoxReference } from "../../shared/contract/box";
import { assertBoxClient } from "../../shared/contract/box-descriptor";

/** @approved The composer's staged Moves, which a Box window adds to. */
export type MoveStaging = { readonly moves: BoxMoves; onChange(moves: BoxMoves): void };

// @approved
//  Whether a Box has its Chat surfaces in this Chat: present, enabled or
// disabled. Only an enabled Box runs, so a disabled Box's surfaces read and
// configure it while its Moves, digests and catch-up wait.
export const boxPresent = ({ boxes }: { readonly boxes: BoxStates }, box: BoxId): boolean => boxes[box] === "enabled" || boxes[box] === "disabled";


/** @approved Hidden windows stay mounted; `visible` gates effects that require viewing. `staging` is null while the Box is not enabled. */
type Panel = ComponentType<{
	visible: boolean;
	conversation: ConversationSummary;
	disabled: boolean;
	staging: MoveStaging | null;
	onConversationChange: (conversation: ConversationSummary) => void;
}>;
/** A Box's one-line status, which the dock, the header item and the Box manager show. */
type Status = ComponentType<{ conversation: ConversationSummary }>;

/** @approved Any Box's window; a digesting Box builds its own with `digestWindow`. */
export interface BoxWindowDefinition {
	readonly size: { readonly width: number; readonly height: number };
	readonly lens?: BoxLens;
	readonly Panel: Panel;
}

/** @approved Props shared by every Box inspector; the host owns focus and workspace navigation. */
export interface BoxInspectorProps {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	focusRequest: { messageId: number } | null;
	onClose: () => void;
	onNavigateSource: (messageId: number) => void;
	onOpenSettings: () => void;
	onOpenConnections: () => void;
}

//  A Box's client module default-exports this: its descriptor and its client
// surfaces, each optional. A `PrimaryPanel` edits in the workspace's primary
// panel rather than a window, and the writer opens it there. Every Chat
// surface shows while the Box is present in the Chat, enabled or disabled; a
// trace view belongs to its Generation and shows whenever its trace exists.
// `header` puts the Box's `Status` in the Chat tools, which opens its window.
export interface BoxClientDefinition {
	readonly descriptor: BoxDescriptor;
	readonly icon: LucideIcon;
	readonly Window?: BoxWindowDefinition;
	readonly Status?: Status;
	readonly header?: true;
	readonly PrimaryPanel?: ComponentType<{ conversation: ConversationSummary; disabled: boolean; onConversationChange: (conversation: ConversationSummary) => void }>;
	readonly Inspector?: { readonly label: string; readonly Component: ComponentType<BoxInspectorProps> };
	readonly Settings?: ComponentType;
	readonly ParticipantSection?: ComponentType<{ conversation: ConversationSummary; participant: CastParticipant }>;
	readonly TraceView?: ComponentType<{ conversationId: number; trace: BoxTrace; onNavigateSource?: (messageId: number) => void }>;
}

/** @approved What a thrown value says, for a failure the host shows. */
export const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** @approved A Box the server loaded: its metadata, a versioned Box's version, and its client module or why that did not load; a Box without its client module has no surfaces. */
export type LoadedBox = { readonly metadata: BoxMetadata; readonly version?: string } & ({ readonly client: BoxClientDefinition } | { readonly failure: string });

// @approved
//  The catalog, each Box by id in registry order, a versioned Box at its
// `latest`; and every version of a versioned Box this client has built, by
// `<id>@<hash>`, `latest` included. A version's client is built once and
// kept, so a frame on it keeps its Worker while another Chat runs another.
let loaded: ReadonlyMap<BoxId, LoadedBox> = new Map();
const versions = new Map<string, LoadedBox>();
const loadingVersions = new Map<string, Promise<void>>();
export const boxVersionKey = (id: BoxId, version: string) => `${id}@${version}`;
/** @approved Every Box the server loaded, by id, in registry order, whether or not its client module loaded. */
export const loadedBoxes = (): ReadonlyMap<BoxId, LoadedBox> => loaded;
/** @approved Each catalog Box's client module, by id, in registry order. */
export const boxClients = (): (readonly [BoxId, BoxClientDefinition])[] => [...loaded].flatMap(([id, box]) => "client" in box ? [[id, box.client] as const] : []);
/** @approved A catalog Box's client module; a Box whose module did not load has none. */
export const boxClient = (id: BoxId): BoxClientDefinition | undefined => {
	const box = loaded.get(id);
	return box !== undefined && "client" in box ? box.client : undefined;
};

/** @approved The pins a Chat holds, by Box id. */
type Pinned = { readonly boxVersions: Readonly<Record<BoxId, string>> };
export const noPins: Pinned = { boxVersions: {} };
/** @approved The open Chat's pins, for a surface such as a Move chip that renders a Box without being handed the Chat. */
export const ChatPins = createContext<Pinned>(noPins);
// @approved
//  A Box as this Chat runs it: a versioned Box at the version the Chat pins,
// or at `latest` when it pins none, and any other Box as loaded. A pinned
// version this client has not built yet resolves to nothing, so no surface
// silently runs `latest` for a Chat on another version.
const chatEntry = ({ boxVersions }: Pinned, id: BoxId): LoadedBox | undefined => {
	const latest = loaded.get(id);
	const pin = boxVersions[id];
	return pin === undefined || latest?.version === undefined || pin === latest.version ? latest : versions.get(boxVersionKey(id, pin));
};
/** @approved The version a Chat runs a Box at; an unversioned Box has none. */
export const chatBoxVersion = (conversation: Pinned, id: BoxId): string | undefined => chatEntry(conversation, id)?.version;
/** @approved A Box's client module as this Chat runs it. */
export const chatBoxClient = (conversation: Pinned, id: BoxId): BoxClientDefinition | undefined => {
	const box = chatEntry(conversation, id);
	return box !== undefined && "client" in box ? box.client : undefined;
};
/** @approved A Box's descriptor as this Chat runs it: a pinned version's own, or the catalog's from the shared registry. */
export const chatBoxDescriptor = (conversation: Pinned, id: BoxId): BoxDescriptor | undefined =>
	chatEntry(conversation, id) === loaded.get(id) ? boxDescriptors().get(id) : chatBoxClient(conversation, id)?.descriptor;
/** @approved Each catalog Box's client module as this Chat runs it, in registry order. */
export const chatBoxClients = (conversation: Pinned): (readonly [BoxId, BoxClientDefinition])[] =>
	[...loaded.keys()].flatMap((id) => {
		const client = chatBoxClient(conversation, id);
		return client === undefined ? [] : [[id, client] as const];
	});
/** @approved Whether this client has built every version the Chat pins. */
export const boxVersionsBuilt = ({ boxVersions }: Pinned): boolean =>
	Object.entries(boxVersions).every(([id, version]) => loaded.get(id)?.version === undefined || versions.has(boxVersionKey(id, version)));
// @approved
//  Builds the client of each version a Chat pins that this client lacks,
// from the descriptor the server serves for it, before the Chat's summary is
// used. Concurrent callers share one request per version. A pin this client
// never saw may be a `latest` another tab installed, so the catalog is read
// again with it, and Update never offers an older version as the newer one.
export const loadBoxVersions = async ({ boxVersions }: Pinned): Promise<void> => {
	if (boxVersionsBuilt({ boxVersions })) return;
	await Promise.all([addBoxClients(), ...Object.entries(boxVersions).flatMap(([id, version]) => {
		const latest = loaded.get(id);
		const key = boxVersionKey(id, version);
		if (latest?.version === undefined || versions.has(key)) return [];
		const pending = loadingVersions.get(key) ?? requestData(api.api.boxes({ box: id }).versions({ version }).get(), boxVersionListing)
			.then(({ sandboxed }) => sandboxedClient(id, sandboxed, version))
			.then((client) => ({ client }), (error: Error) => ({ failure: error.message }))
			.then((built) => { versions.set(key, { metadata: latest.metadata, version, ...built }); })
			.finally(() => loadingVersions.delete(key));
		loadingVersions.set(key, pending);
		return [pending];
	})]);
};

const loadBoxClient = async (id: BoxId, url: string): Promise<BoxClientDefinition> => {
	// @approved
	// SAFETY: assertBoxClient checks the descriptor and that each surface is a component; each Box types its own with `satisfies BoxClientDefinition`.
	const { default: client }: { default: BoxClientDefinition | undefined } = await import(/* @vite-ignore */ url);
	if (client === undefined) throw new Error("Its client module has no default export.");
	assertBoxClient(client);
	if (client.descriptor.id !== id) throw new Error(`Its client module is the ${client.descriptor.id} Box's.`);
	return client;
};

// @approved
//  The host renders only once every Box module has settled, so a module whose
// import never does, such as one whose stylesheet request stalls, would keep
// the whole app blank. Each gets ten seconds, plenty for a same-origin module
// and its stylesheet on a slow link and short enough that a stalled Box blanks
// the app only briefly; past it, the module is refused like a failed import.
const BOX_CLIENT_DEADLINE_MS = 10_000;
const withinDeadline = async <T>(load: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Its client module did not load within ${BOX_CLIENT_DEADLINE_MS / 1000} seconds.`)), BOX_CLIENT_DEADLINE_MS);
	});
	try { return await Promise.race([load, late]); } finally { clearTimeout(timer); }
};

// @approved
//  Startup imports every trusted Box's client module, in parallel, and builds
// every sandboxed Box's client from its descriptor, before the host renders
// any Box surface, and installs each Box with its metadata and its client. A
// client that fails to import, misses its deadline, or whose descriptor the
// host refuses keeps its reason for the Box manager, which still manages the
// Box: the server owns which Boxes exist, and a Box runs there whether or not
// its client loads.
export const loadBoxClients = async (): Promise<void> => {
	const boxes = await requestData(api.api.boxes.get(), boxList);
	const settled = await Promise.allSettled(boxes.map(clientOf));
	loaded = new Map(boxes.map((listed, index) => [listed.id, loadedFrom(listed, settled[index]!)])); // @approved allSettled answers each Box, in order.
	installLoaded();
};

type ListedBox = Static<typeof boxList>[number];
const listedVersion = (listed: ListedBox) => "sandboxed" in listed ? listed.version : undefined;
const clientOf = async (listed: ListedBox) => "client" in listed ? await withinDeadline(loadBoxClient(listed.id, listed.client)) : sandboxedClient(listed.id, listed.sandboxed, listed.version);
/** @approved A listed Box with its client or failure; a version this client already built keeps that client. */
const loadedFrom = (listed: ListedBox, result: PromiseSettledResult<BoxClientDefinition>): LoadedBox => {
	const metadata = boxMetadataFrom(listed);
	const version = listedVersion(listed);
	const built = version === undefined ? undefined : versions.get(boxVersionKey(listed.id, version));
	if (built !== undefined) return built;
	const box: LoadedBox = result.status === "fulfilled" ? { metadata, ...version !== undefined && { version }, client: result.value } : { metadata, ...version !== undefined && { version }, failure: errorMessage(result.reason) };
	if (version !== undefined) versions.set(boxVersionKey(listed.id, version), box);
	return box;
};
const installLoaded = () => installBoxes([...loaded.values()].map((box) => ({ metadata: box.metadata, descriptor: "client" in box ? box.client.descriptor : undefined })));

// @approved
//  Boxes the server installed while the app ran join the registry: every one
// it lists that this client has not loaded, after the rest, and every
// versioned Box whose `latest` moved, in its place, so a Box another writer
// installed meanwhile joins too. Every version already built keeps its
// client definition as it is: a rebuilt sandboxed client's window would be a
// new component, and React would replace each open frame, its Worker and its
// unsaved guest state.
export const addBoxClients = async (): Promise<void> => {
	const changed = (await requestData(api.api.boxes.get(), boxList)).filter((listed) => !loaded.has(listed.id) || loaded.get(listed.id)?.version !== listedVersion(listed));
	const settled = await Promise.allSettled(changed.map(clientOf));
	const updates = new Map(changed.map((listed, index) => [listed.id, loadedFrom(listed, settled[index]!)] as const)); // @approved allSettled answers each Box, in order.
	loaded = new Map([...[...loaded].map(([id, box]) => [id, updates.get(id) ?? box] as const), ...[...updates].filter(([id]) => !loaded.has(id))]);
	installLoaded();
};

/** How a Box opens, or undefined when it has no client surface to open: its primary panel when it has one, otherwise its window. */
export const boxOpening = (box: BoxId, open: { readonly panel: (panel: PromptBoxReference) => void; readonly window: (box: BoxId) => void }): (() => void) | undefined => {
	const { PrimaryPanel, Window } = boxClient(box) ?? {};
	if (PrimaryPanel !== undefined) return () => open.panel(boxReference(box));
	if (Window !== undefined) return () => open.window(box);
	return undefined;
};
