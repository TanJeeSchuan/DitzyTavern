import type { PromptChannels } from "./contract/prompt-schema";

// ==[HUMAN APPROVED]== Shared Prompt channel vocabulary and presentation derivation, safe for
// client and server alike. This module is the single owner of the Prompt
// channel metadata (exhaustive labels, editor order, derived field list) and
// of the empty Prompt constructor. The server uses the presentation rules to
// put a short preview on Character Library list entries (so the Cast picker
// never needs one detail request per Character), and clients use the same
// helpers for any local formatting.

// ==[HUMAN APPROVED]== Channel labels, exhaustive against the contract: adding a channel to
// `promptChannels` without a label here is a compile error.
export const promptChannelLabels = {
	systemInstruction: "System Instruction",
	identity: "Identity",
	scenario: "Scenario",
	exampleDialogue: "Example Dialogue",
	postHistoryInstruction: "Post-History Instruction",
} as const satisfies Record<keyof PromptChannels, string>;

// ==[HUMAN APPROVED]== The explicit editor order, in the stable authoring order shared by every
// Prompt editor. `satisfies` keeps every entry a real contract key, and the
// exhaustiveness assertion in the exported declaration below turns a
// contract channel missing from this list into a type error naming the gap.
const promptChannelOrderEntries = [
	"systemInstruction",
	"identity",
	"scenario",
	"exampleDialogue",
	"postHistoryInstruction",
] as const satisfies readonly (keyof PromptChannels)[];

type UnorderedChannel = Exclude<keyof PromptChannels, (typeof promptChannelOrderEntries)[number]>;

// ==[HUMAN APPROVED]== Compile-time assertion only (a type annotation, not runtime logic): a
// contract channel missing from the entries above makes this exported type
// require it appended, so the assignment fails to compile naming the gap.
export const promptChannelOrder: UnorderedChannel extends never
	? typeof promptChannelOrderEntries
	: readonly [...typeof promptChannelOrderEntries, UnorderedChannel] = promptChannelOrderEntries;

// ==[HUMAN APPROVED]== The derived { key, label } field list, in the editor order above.
export const promptChannelFields: ReadonlyArray<{
	key: (typeof promptChannelOrder)[number];
	label: string;
}> = promptChannelOrder.map((channel) => ({
	key: channel,
	label: promptChannelLabels[channel],
}));

// ==[HUMAN APPROVED]== The single empty Prompt constructor. A factory rather than a shared const,
// so no caller can mutate a Prompt owned by another caller.
export const emptyPromptChannels = (): PromptChannels => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

export const promptPreview = (value: string, maxLength = 140): string => {
	const trimmed = value.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength).trimEnd()}…`;
};
