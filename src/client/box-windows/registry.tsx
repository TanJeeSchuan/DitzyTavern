import type { BoxLens } from "./lens";
import memoryClient from "../../boxes/memory/client";
import { Drama, Flag, MessageCircleDashed, Clock, NotebookPen, Smartphone, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { CastParticipant, ConversationSummary } from "../conversation";
import { RaceDockTab } from "../../boxes/race/client-window";
import { RacePanel } from "../../boxes/race/client";
import type { BoxMoves, BoxTrace } from "../../shared/contract/box-generation";
import { boxDescriptor, installBoxDescriptors, type BoxId } from "../../shared/contract/box";
import type { ConversationAction } from "../../shared/contract/conversation-schema";
import { describeWorldClock, WorldClockPanel, WorldClockTopBarItem } from "../../boxes/world-clock/client";
import { PhoneDockTab, phoneLens, PhonePanel } from "../../boxes/phone/client";
import { ThoughtDockTab, thoughtLens, ThoughtPanel } from "../../boxes/thought/client";
import { digestWindow } from "./PassageTimeline";

import { AuthorNotePanel } from "../../boxes/author-note/client";

import authorNote from "../../boxes/author-note/shared-descriptor";
import memory from "../../boxes/memory/shared-descriptor";
import mood from "../../boxes/mood/shared-descriptor";
import phone from "../../boxes/phone/shared-descriptor";
import race from "../../boxes/race/shared-descriptor";
import thought from "../../boxes/thought/shared-descriptor";
import worldClock from "../../boxes/world-clock/shared-descriptor";

// @approved
//  The built-in Boxes' descriptors, in the server's registry order, installed
//  before any entry below reads them, until the client loads each Box's
//  client module from `GET /api/boxes` (ticket 27).
installBoxDescriptors([authorNote, memory, mood, phone, race, thought, worldClock]);

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
	readonly icon: LucideIcon;
	readonly size: { readonly width: number; readonly height: number };
	readonly lens?: BoxLens;
	readonly Panel: Panel;
	readonly DockTab: DockTab;
}

const worldClockWindow = digestWindow("world-clock", { icon: Clock, size: { width: 25, height: 30 }, Panel: WorldClockPanel, describe: describeWorldClock });
const moodWindow = digestWindow("mood", { icon: Drama, size: { width: 22, height: 26 } });

// @approved
//  Client surfaces are registered once. Window and primary-panel consumers
//  select their entries below; every other surface reads this registry.
export const boxClients: ReadonlyMap<BoxId, BoxClientDefinition> = new Map(Object.entries({
	"world-clock": { icon: worldClockWindow.icon, Window: worldClockWindow, TopBarItem: WorldClockTopBarItem },
	race: { icon: Flag, Window: { size: { width: 27, height: 34 }, DockTab: RaceDockTab, Panel: RacePanel } },
	phone: { icon: Smartphone, Window: { size: { width: 22, height: 30 }, DockTab: PhoneDockTab, Panel: PhonePanel, lens: phoneLens } },
	thought: { icon: MessageCircleDashed, Window: { size: { width: 22, height: 30 }, DockTab: ThoughtDockTab, Panel: ThoughtPanel, lens: thoughtLens } },
	mood: { icon: moodWindow.icon, Window: moodWindow },
	"author-note": { icon: NotebookPen, PrimaryPanel: AuthorNotePanel },
	memory: memoryClient,
} satisfies Readonly<Record<BoxId, BoxClientDefinition>>));

/** @approved A Box that edits in the workspace's primary panel rather than a window; the composer opens it there. */
export interface BoxPanelDefinition {
	readonly icon: LucideIcon;
	readonly Panel: ComponentType<{ conversation: ConversationSummary; disabled: boolean; onConversationChange: (conversation: ConversationSummary) => void }>;
}
export const boxWindows: ReadonlyMap<BoxId, BoxWindowDefinition> = new Map([...boxClients].flatMap(([id, entry]) => entry.Window ? [[id, { icon: entry.icon, ...entry.Window }]] : []));
export const boxPanels: ReadonlyMap<BoxId, BoxPanelDefinition> = new Map([...boxClients].flatMap(([id, entry]) => entry.PrimaryPanel ? [[id, { icon: entry.icon, Panel: entry.PrimaryPanel }]] : []));

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

/** @approved Optional client surfaces; inspectors remain available while the Box is disabled, and captured traces outlive its Chat state. */
export interface BoxClientDefinition {
	readonly icon: LucideIcon;
	readonly Window?: Omit<BoxWindowDefinition, "icon">;
	readonly PrimaryPanel?: BoxPanelDefinition["Panel"];
	readonly TopBarItem?: TopBarItem;
	readonly Inspector?: { readonly label: string; readonly Component: ComponentType<BoxInspectorProps> };
	readonly Settings?: ComponentType;
	readonly ParticipantSection?: ComponentType<{ conversation: ConversationSummary; participant: CastParticipant }>;
	readonly TraceView?: ComponentType<{ conversationId: number; trace: BoxTrace; onNavigateSource?: (messageId: number) => void }>;
}
