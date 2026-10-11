import { Flag, Clock, Smartphone, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { ConversationSummary } from "../conversation";
import { RaceDockTab } from "./RaceWindow";
import { RacePanel } from "./RaceMoves";
import type { BoxMoves } from "../../shared/contract/box-generation";
import { WorldClockDockTab, WorldClockWindow } from "./WorldClockWindow";
import { PhoneDockTab, PhoneLensView, PhonePanel } from "./PhoneWindow";
import { stripPhoneTexts, type PhoneNames, type PhoneSegment, type Sms } from "../../shared/phone";

/** @approved The composer's staged Moves, which a Box window adds to. */
export type MoveStaging = { readonly moves: BoxMoves; onChange(moves: BoxMoves): void };

export interface BoxWindowDefinition {
	readonly title: string;
	readonly icon: LucideIcon;
	readonly size: { readonly width: number; readonly height: number };
	readonly DockTab: ComponentType<{ conversation: ConversationSummary; onRestore: () => void }>;
	readonly Panel: ComponentType<{ conversation: ConversationSummary; disabled: boolean; staging: MoveStaging; onConversationChange: (conversation: ConversationSummary) => void }>;
	/** @approved The story view renders `strip`'s segments, each lifted one as `View`; the prompt keeps the markup. */
	readonly lens?: { strip(text: string, names: PhoneNames): PhoneSegment[]; readonly View: ComponentType<{ text: Sms; onOpen: () => void }> };
}

// @approved
//  The client half of the Box contract's `window` and `lens`. The server Box
//  declares `status(setup, state)`; this registry declares the icon, size,
//  Panel and lens, because they are React and the server contract is not.
//  The composer's launcher and the dock render this list.
export const windowBoxIds = ["world-clock", "race", "phone"] as const;
export type WindowBoxId = typeof windowBoxIds[number];

export const boxWindows = {
	race: { title: "Race", icon: Flag, size: { width: 27, height: 34 }, DockTab: RaceDockTab, Panel: RacePanel },
	"world-clock": {
		title: "World Clock",
		icon: Clock,
		size: { width: 25, height: 30 },
		DockTab: WorldClockDockTab,
		Panel: WorldClockWindow,
	},
	phone: { title: "Phone", icon: Smartphone, size: { width: 22, height: 30 }, DockTab: PhoneDockTab, Panel: PhonePanel, lens: { strip: stripPhoneTexts, View: PhoneLensView } },
} satisfies Record<WindowBoxId, BoxWindowDefinition>;
