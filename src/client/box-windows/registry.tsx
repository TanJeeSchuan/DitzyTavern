import { Drama, Flag, MessageCircleDashed, Clock, NotebookPen, Smartphone, type LucideIcon } from "lucide-react";
import type { ComponentType, ReactElement } from "react";
import type { ConversationSummary } from "../conversation";
import { RaceDockTab } from "../../boxes/race/client-window";
import { RacePanel } from "../../boxes/race/client";
import type { BoxMoves } from "../../shared/contract/box-generation";
import { boxDescriptor, installBoxDescriptors, type BoxId } from "../../shared/contract/box";
import type { ConversationAction } from "../../shared/contract/conversation-schema";
import { describeWorldClock, WorldClockPanel, WorldClockTopBarItem } from "../../boxes/world-clock/client";
import { PhoneDockTab, PhoneLensView, PhonePanel } from "../../boxes/phone/client";
import { phoneNames, stripPhoneTexts } from "../../boxes/phone/shared";
import { ThoughtDockTab, ThoughtLensView, ThoughtPanel } from "../../boxes/thought/client";
import { stripThoughts } from "../../boxes/thought/shared";
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
//  Memory's contract, shared logic and client helpers, for its in-tree side
//  panel, settings editor and trace view, until that UI moves into its Box
//  (GitHub #24).
export * from "../../boxes/memory/contract";
export * from "../../boxes/memory/shared";
export * from "../../boxes/memory/client";

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
/** @approved A top bar item's content; the host wraps it in a button that opens the window. */
type TopBarItem = ComponentType<{ conversation: ConversationSummary }>;

/** @approved Any Box's window; a digesting Box builds its own with `digestWindow`. */
export interface BoxWindowDefinition {
	readonly icon: LucideIcon;
	readonly size: { readonly width: number; readonly height: number };
	readonly lens?: BoxLens;
	readonly Panel: Panel;
	readonly DockTab: DockTab;
	readonly TopBarItem?: TopBarItem;
}

// @approved
//  The story view replaces each `<tag>` a lens lifts with a mark that opens
//  the Box; the prompt keeps the markup. `gate` returns nothing when the lens
//  has nothing to lift in this Chat. While streaming, an unclosed `<tag`
//  stays hidden rather than flash as markup.
export interface BoxLens {
	readonly tag: string;
	gate(conversation: ConversationSummary): ((text: string, onOpen: () => void) => readonly LensPiece[]) | undefined;
}
export type LensPiece = { readonly kind: "prose"; readonly text: string } | { readonly kind: "lifted"; readonly element: ReactElement };

type Segment<Kind extends string, Text> = { readonly kind: "prose"; readonly text: string } | { readonly kind: Kind; readonly text: Text };
const lens = <Context, Kind extends string, Text>(
	tag: Kind,
	gate: (conversation: ConversationSummary) => Context | undefined,
	strip: (text: string, context: Context) => readonly Segment<Kind, Text>[],
	View: ComponentType<{ text: Text; onOpen: () => void }>,
): BoxLens => {
	const lifted = (segment: Segment<Kind, Text>): segment is { readonly kind: Kind; readonly text: Text } => segment.kind === tag;
	return {
		tag,
		gate: (conversation) => {
			const context = gate(conversation);
			return context === undefined ? undefined : (text, onOpen) => strip(text, context).map((segment) => lifted(segment)
				? { kind: "lifted", element: <View text={segment.text} onOpen={onOpen} /> }
				: { kind: "prose", text: segment.text });
		},
	};
};

const castNames = ({ cast, control }: ConversationSummary) => {
	const human = cast.find(({ id }) => id === control.humanParticipantId);
	return human === undefined ? undefined : phoneNames(cast, human);
};

// @approved
//  The client half of the Box contract: the server Box declares `status` and
//  `read`; this registry declares the icon, size, Panel, lens and top bar
//  item, because they are React and the server contract is not. The
//  composer's launcher, the dock, the story's lenses and the top bar render
//  the Boxes listed here, in this order.
export const boxWindows: ReadonlyMap<BoxId, BoxWindowDefinition> = new Map(Object.entries({
	"world-clock": { ...digestWindow("world-clock", { icon: Clock, size: { width: 25, height: 30 }, Panel: WorldClockPanel, describe: describeWorldClock }), TopBarItem: WorldClockTopBarItem },
	race: { icon: Flag, size: { width: 27, height: 34 }, DockTab: RaceDockTab, Panel: RacePanel },
	phone: { icon: Smartphone, size: { width: 22, height: 30 }, DockTab: PhoneDockTab, Panel: PhonePanel, lens: lens("sms", castNames, stripPhoneTexts, PhoneLensView) },
	thought: { icon: MessageCircleDashed, size: { width: 22, height: 30 }, DockTab: ThoughtDockTab, Panel: ThoughtPanel, lens: lens("thought", () => true, stripThoughts, ThoughtLensView) },
	mood: digestWindow("mood", { icon: Drama, size: { width: 22, height: 26 } }),
} satisfies Readonly<Record<BoxId, BoxWindowDefinition>>));

/** @approved A Box that edits in the workspace's primary panel rather than a window; the composer opens it there. */
export interface BoxPanelDefinition {
	readonly icon: LucideIcon;
	readonly Panel: ComponentType<{ conversation: ConversationSummary; disabled: boolean; onConversationChange: (conversation: ConversationSummary) => void }>;
}
export const boxPanels: ReadonlyMap<BoxId, BoxPanelDefinition> = new Map(Object.entries({
	"author-note": { icon: NotebookPen, Panel: AuthorNotePanel },
} satisfies Readonly<Record<BoxId, BoxPanelDefinition>>));
