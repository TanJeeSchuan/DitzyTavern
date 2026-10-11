import { Flag, Clock, Smartphone, type LucideIcon } from "lucide-react";
import type { ComponentType, ReactElement } from "react";
import type { ConversationSummary } from "../conversation";
import { RaceDockTab } from "./RaceWindow";
import { RacePanel } from "./RaceMoves";
import type { BoxMoves } from "../../shared/contract/box-generation";
import { boxDescriptors, boxIds, type BoxId } from "../../shared/contract/box";
import type { ConversationAction } from "../../shared/contract/conversation-schema";
import { WorldClockDockTab, WorldClockWindow } from "./WorldClockWindow";
import { PhoneDockTab, PhoneLensView, PhonePanel } from "./PhoneWindow";
import { phoneNames, stripPhoneTexts } from "../../shared/phone";

/** @approved The composer's staged Moves, which a Box window adds to. */
export type MoveStaging = { readonly moves: BoxMoves; onChange(moves: BoxMoves): void };

type PutBoxData = Extract<ConversationAction, { type: "put-box-data" }>;
/** @approved Builds a `put-box-data` command for the window's own Box, so a window cannot name another Box's namespace. */
export type BoxDataAction = (owner: PutBoxData["owner"], key: string, value: string) => PutBoxData;

export const boxTitle = (id: BoxId): string => boxDescriptors[id].label;

export interface BoxWindowDefinition {
	readonly icon: LucideIcon;
	readonly size: { readonly width: number; readonly height: number };
	readonly DockTab: ComponentType<{ conversation: ConversationSummary; onRestore: () => void }>;
	readonly Panel: ComponentType<{ conversation: ConversationSummary; disabled: boolean; staging: MoveStaging; boxData: BoxDataAction; onConversationChange: (conversation: ConversationSummary) => void }>;
	readonly lens?: BoxLens;
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
//  `read`; this registry declares the icon, size, Panel and lens, because
//  they are React and the server contract is not. The composer's launcher,
//  the dock and the story's lenses render the Boxes listed here.
export const boxWindows = {
	"world-clock": { icon: Clock, size: { width: 25, height: 30 }, DockTab: WorldClockDockTab, Panel: WorldClockWindow },
	race: { icon: Flag, size: { width: 27, height: 34 }, DockTab: RaceDockTab, Panel: RacePanel },
	phone: { icon: Smartphone, size: { width: 22, height: 30 }, DockTab: PhoneDockTab, Panel: PhonePanel, lens: lens("sms", castNames, stripPhoneTexts, PhoneLensView) },
} satisfies Partial<Record<BoxId, BoxWindowDefinition>>;

export type WindowBoxId = keyof typeof boxWindows;
export const windowBoxIds = boxIds.filter((id): id is WindowBoxId => Object.hasOwn(boxWindows, id));
