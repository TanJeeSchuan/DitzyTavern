import type { PromptBoxReference } from "../../shared/contract/box";

/** @approved A Box with a panel opens under its own `box:<id>` name. */
export type PrimaryPanelName =
	| PromptBoxReference
	| "chats"
	| "characters"
	| "lorebooks"
	| "prompts"
	| "connections"
	| "generation"
	| `box-settings:${string}`
	| "settings";

export type PrimaryPanel = PrimaryPanelName | null;
