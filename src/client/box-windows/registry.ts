import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { BoxLens } from "./lens";
import type { CastParticipant, ConversationSummary } from "../conversation";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import type { BoxMoves, BoxTrace } from "../../shared/contract/box-generation";
import { boxList, boxMetadataFrom, boxReference, installBoxes, type BoxDescriptor, type BoxId, type BoxMetadata, type BoxStates, type PromptBoxReference } from "../../shared/contract/box";
import { assertBoxClient } from "../../shared/contract/box-descriptor";
import type { ConversationAction } from "../../shared/contract/conversation-schema";

/** @approved The composer's staged Moves, which a Box window adds to. */
export type MoveStaging = { readonly moves: BoxMoves; onChange(moves: BoxMoves): void };

// @approved
//  Whether a Box has its Chat surfaces in this Chat: present, enabled or
// disabled. Only an enabled Box runs, so a disabled Box's surfaces read and
// configure it while its Moves, digests and catch-up wait.
export const boxPresent = ({ boxes }: { readonly boxes: BoxStates }, box: BoxId): boolean => boxes[box] === "enabled" || boxes[box] === "disabled";

type PutBoxData = Extract<ConversationAction, { type: "put-box-data" }>;
/** @approved Builds a `put-box-data` command for the window's own Box, so a window cannot name another Box's namespace. */
export type BoxDataAction = (owner: PutBoxData["owner"], key: string, value: string) => PutBoxData;


/** @approved Hidden windows stay mounted; `visible` gates effects that require viewing. `staging` is null while the Box is not enabled. */
type Panel = ComponentType<{
	visible: boolean;
	conversation: ConversationSummary;
	disabled: boolean;
	staging: MoveStaging | null;
	boxData: BoxDataAction;
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

/** @approved A Box the server loaded: its metadata, and its client module or why that did not load; a Box without its client module has no surfaces. */
export type LoadedBox = { readonly metadata: BoxMetadata } & ({ readonly client: BoxClientDefinition } | { readonly failure: string });

let loaded: ReadonlyMap<BoxId, LoadedBox> = new Map();
/** @approved Every Box the server loaded, by id, in registry order, whether or not its client module loaded. */
export const loadedBoxes = (): ReadonlyMap<BoxId, LoadedBox> => loaded;
/** @approved Each loaded Box's client module, by id, in registry order. */
export const boxClients = (): (readonly [BoxId, BoxClientDefinition])[] => [...loaded].flatMap(([id, box]) => "client" in box ? [[id, box.client] as const] : []);
/** @approved A loaded Box's client module; a Box whose module did not load has none. */
export const boxClient = (id: BoxId): BoxClientDefinition | undefined => {
	const box = loaded.get(id);
	return box !== undefined && "client" in box ? box.client : undefined;
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
//  Startup imports every loaded Box's client module, in parallel, before the
// host renders any Box surface, and installs each Box with its metadata and
// its client module. A module that fails to import, misses its deadline, or
// whose descriptor the host refuses keeps its reason for the Box manager,
// which still manages the Box: the server owns which Boxes exist, and a Box
// runs there whether or not its client loads.
export const loadBoxClients = async (): Promise<void> => {
	const boxes = await requestData(api.api.boxes.get(), boxList);
	const settled = await Promise.allSettled(boxes.map(({ id, client }) => withinDeadline(loadBoxClient(id, client))));
	loaded = new Map(boxes.map((listed, index) => {
		const result = settled[index]!; // @approved allSettled answers each Box, in order.
		const metadata = boxMetadataFrom(listed);
		return [listed.id, result.status === "fulfilled" ? { metadata, client: result.value } : { metadata, failure: errorMessage(result.reason) }];
	}));
	installBoxes([...loaded.values()].map((box) => ({ metadata: box.metadata, descriptor: "client" in box ? box.client.descriptor : undefined })));
};

/** How a Box opens, or undefined when it has no client surface to open: its primary panel when it has one, otherwise its window. */
export const boxOpening = (box: BoxId, open: { readonly panel: (panel: PromptBoxReference) => void; readonly window: (box: BoxId) => void }): (() => void) | undefined => {
	const { PrimaryPanel, Window } = boxClient(box) ?? {};
	if (PrimaryPanel !== undefined) return () => open.panel(boxReference(box));
	if (Window !== undefined) return () => open.window(box);
	return undefined;
};
