import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { BoxLens } from "./lens";
import type { CastParticipant, ConversationSummary } from "../conversation";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import type { BoxMoves, BoxTrace } from "../../shared/contract/box-generation";
import { boxList, installBoxDescriptors, type BoxDescriptor, type BoxId, type BoxStates } from "../../shared/contract/box";
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


type DockTab = ComponentType<{ conversation: ConversationSummary; onRestore: () => void }>;
/** @approved `staging` is null while the Box is not enabled, so it shows its Move controls as unavailable. */
type Panel = ComponentType<{
	conversation: ConversationSummary;
	disabled: boolean;
	staging: MoveStaging | null;
	boxData: BoxDataAction;
	onConversationChange: (conversation: ConversationSummary) => void;
}>;
/** @approved A top bar item's content; the host wraps it in a button that opens its window. */
type TopBarItem = ComponentType<{ conversation: ConversationSummary }>;

/** @approved Any Box's window; a digesting Box builds its own with `digestWindow`. */
export interface BoxWindowDefinition {
	readonly size: { readonly width: number; readonly height: number };
	readonly lens?: BoxLens;
	readonly Panel: Panel;
	readonly DockTab: DockTab;
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

// @approved
//  A Box's client module default-exports this: its descriptor and its client
// surfaces, each optional. A `PrimaryPanel` edits in the workspace's primary
// panel rather than a window, and the composer opens it there. Every Chat
// surface shows while the Box is present in the Chat, enabled or disabled; a
// trace view belongs to its Generation and shows whenever its trace exists.
export interface BoxClientDefinition {
	readonly descriptor: BoxDescriptor;
	readonly icon: LucideIcon;
	readonly Window?: BoxWindowDefinition;
	readonly PrimaryPanel?: ComponentType<{ conversation: ConversationSummary; disabled: boolean; onConversationChange: (conversation: ConversationSummary) => void }>;
	readonly TopBarItem?: TopBarItem;
	readonly Inspector?: { readonly label: string; readonly Component: ComponentType<BoxInspectorProps> };
	readonly Settings?: ComponentType;
	readonly ParticipantSection?: ComponentType<{ conversation: ConversationSummary; participant: CastParticipant }>;
	readonly TraceView?: ComponentType<{ conversationId: number; trace: BoxTrace; onNavigateSource?: (messageId: number) => void }>;
}

/** @approved What a thrown value says, for a failure the host shows. */
export const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** @approved A Box the server loaded, with why its client module did not load, or null; a Box without its client module has no surfaces. */
export type ListedBox = { readonly id: BoxId; readonly label: string; readonly failure: string | null };

let listed: ReadonlyMap<BoxId, ListedBox> = new Map();
let clients: ReadonlyMap<BoxId, BoxClientDefinition> = new Map();
/** @approved Every Box the server loaded, by id, in registry order, whether or not its client module loaded. */
export const listedBoxes = (): ReadonlyMap<BoxId, ListedBox> => listed;
/** @approved Each loaded Box's client module, by id, in registry order. */
export const boxClients = (): ReadonlyMap<BoxId, BoxClientDefinition> => clients;

/** @approved A loaded Box's label, as the server lists it. An unknown id throws, so a boundary checks ids first. */
export const boxTitle = (id: BoxId): string => {
	const box = listed.get(id);
	if (box === undefined) throw new Error(`There is no ${id} Box.`);
	return box.label;
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
//  Startup imports every loaded Box's client module, in parallel, before the
// host renders any Box surface, and installs their descriptors and surfaces.
// A module that fails to import, or whose descriptor the host refuses, keeps
// its reason for the Box manager, which still manages the Box: the server
// owns which Boxes exist, and a Box runs there whether or not its client loads.
export const loadBoxClients = async (): Promise<void> => {
	const boxes = await requestData(api.api.boxes.get(), boxList);
	const loaded = await Promise.allSettled(boxes.map(({ id, client }) => loadBoxClient(id, client)));
	const modules = loaded.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
	installBoxDescriptors(modules.map(({ descriptor }) => descriptor));
	clients = new Map(modules.map((client) => [client.descriptor.id, client]));
	listed = new Map(boxes.map(({ id, label }, index) => {
		const result = loaded[index]!;
		return [id, { id, label, failure: result.status === "rejected" ? errorMessage(result.reason) : null }];
	}));
};
