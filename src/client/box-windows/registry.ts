import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { BoxLens } from "./lens";
import type { CastParticipant, ConversationSummary } from "../conversation";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import type { BoxMoves, BoxTrace } from "../../shared/contract/box-generation";
import { boxDescriptor, boxList, installBoxDescriptors, type BoxDescriptor, type BoxId } from "../../shared/contract/box";
import { assertBoxClient } from "../../shared/contract/box-descriptor";
import type { ConversationAction } from "../../shared/contract/conversation-schema";

/** @approved The composer's staged Moves, which a Box window adds to. */
export type MoveStaging = { readonly moves: BoxMoves; onChange(moves: BoxMoves): void };

type PutBoxData = Extract<ConversationAction, { type: "put-box-data" }>;
/** @approved Builds a `put-box-data` command for the window's own Box, so a window cannot name another Box's namespace. */
export type BoxDataAction = (owner: PutBoxData["owner"], key: string, value: string) => PutBoxData;

export const boxTitle = (id: BoxId): string => boxDescriptor(id).label;

type DockTab = ComponentType<{ conversation: ConversationSummary; onRestore: () => void }>;
type Panel = ComponentType<{ conversation: ConversationSummary; disabled: boolean; staging: MoveStaging; boxData: BoxDataAction; onConversationChange: (conversation: ConversationSummary) => void }>;
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
// panel rather than a window, and the composer opens it there. Inspectors
// remain available while the Box is disabled, and captured traces outlive
// its Chat state.
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

/** @approved A loaded Box whose client module did not load, with why; none of its surfaces show. */
export type BoxClientFailure = { readonly id: BoxId; readonly reason: string };

let clients: ReadonlyMap<BoxId, BoxClientDefinition> = new Map();
let failures: readonly BoxClientFailure[] = [];
/** @approved Each loaded Box's client module, by id, in registry order. */
export const boxClients = (): ReadonlyMap<BoxId, BoxClientDefinition> => clients;
export const boxClientFailures = (): readonly BoxClientFailure[] => failures;

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
// A module that fails to import, or whose descriptor the host refuses, is
// kept with its reason for the Box manager; the other Boxes still load.
export const loadBoxClients = async (): Promise<void> => {
	const listed = await requestData(api.api.boxes.get(), boxList);
	const loaded = await Promise.allSettled(listed.map(({ id, client }) => loadBoxClient(id, client)));
	const modules = loaded.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
	installBoxDescriptors(modules.map(({ descriptor }) => descriptor));
	clients = new Map(modules.map((client) => [client.descriptor.id, client]));
	failures = loaded.flatMap((result, index) => result.status === "rejected"
		? [{ id: listed[index]!.id, reason: errorMessage(result.reason) }]
		: []);
};
