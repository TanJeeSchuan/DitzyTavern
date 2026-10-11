import { Clock, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { ConversationSummary } from "../conversation";
import { WorldClockDockTab, WorldClockWindow } from "./WorldClockWindow";

export interface BoxWindowDefinition {
	readonly title: string;
	readonly icon: LucideIcon;
	readonly size: { readonly width: number; readonly height: number };
	readonly DockTab: ComponentType<{ conversation: ConversationSummary; onRestore: () => void }>;
	readonly Panel: ComponentType<{ conversation: ConversationSummary; disabled: boolean; onConversationChange: (conversation: ConversationSummary) => void }>;
}

// @approved
//  The client half of the Box contract's `window`. The server Box declares
//  `status(setup, state)`; this registry declares the icon, size and Panel,
//  because Panel is React and the server contract is not. The composer's
//  launcher and the dock render this list.
export const windowBoxIds = ["world-clock"] as const;
export type WindowBoxId = typeof windowBoxIds[number];

export const boxWindows = {
	"world-clock": {
		title: "World Clock",
		icon: Clock,
		size: { width: 25, height: 30 },
		DockTab: WorldClockDockTab,
		Panel: WorldClockWindow,
	},
} satisfies Record<WindowBoxId, BoxWindowDefinition>;
