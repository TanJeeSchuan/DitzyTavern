// ==[HUMAN APPROVED]== Deterministic Prompt compilation.
//
// Fixed version-one block order: System Instruction, human Identity, model
// Identity, Scenario, Example Dialogue, selected history, Post-History
// Instruction. Both controlled Participants contribute Identity; only the
// model-controlled Definition contributes the other Definition blocks. Empty
// blocks are omitted from the rendered plan only — storage keeps exact text.
//
// `{{self}}` and `{{other}}` expand relative to the Definition owner,
// case-sensitively and in one pass; expansion output is never rescanned. A
// backslash escapes a recognized macro (`\{{self}}` renders `{{self}}`).
// Unknown macros remain literal and become prompt-inspection warnings.

import type { PromptChannels } from "../../shared/contract/prompt-schema";
import type {
	CompilePromptInput,
	ExpansionResult,
	MacroContext,
	PromptBlock,
	PromptPlan,
	PromptWarning,
} from "./types";

// ==[HUMAN APPROVED]== The version-one channel→block-kind correspondence, exhaustive over the
// shared Prompt contract: a channel added to `promptChannels` without an
// entry here is a compile error, and every Definition block the plan can
// contain is named by the channel that compiles into it. `identity` names
// the role-distinguished identity block; the construction below compiles it
// once per controlled Definition (human, then model). History blocks are
// not channel-derived and stay outside this mapping.
const channelBlockKinds = {
	systemInstruction: "system-instruction",
	identity: "identity",
	scenario: "scenario",
	exampleDialogue: "example-dialogue",
	postHistoryInstruction: "post-history-instruction",
} as const satisfies Record<
	keyof PromptChannels,
	Exclude<PromptBlock["kind"], "history">
>;

// ==[HUMAN APPROVED]== Version-one recognized macros. Deliberately tiny: general SillyTavern
// macro compatibility beyond `{{self}}`/`{{other}}` is out of scope.
// Returns the expanded value for a recognized macro name, or null when the
// name is unknown. Case-sensitive: `{{SELF}}` and `{{ self }}` are unknown.
const recognize = (name: string, context: MacroContext): string | null => {
	switch (name) {
		case "self":
			return context.self;
		case "other":
			return context.other;
		default:
			return null;
	}
};

interface MacroMatch {
	name: string;
	// ==[HUMAN APPROVED]== Index just past the closing `}}`.
	end: number;
}

// ==[HUMAN APPROVED]== Matches a `{{...}}` starting exactly at `start`; the name is the text
// between the braces, unmodified, so `{{SELF}}` and `{{ self }}` are unknown.
const matchMacro = (source: string, start: number): MacroMatch | null => {
	if (source[start] !== "{" || source[start + 1] !== "{") return null;
	const close = source.indexOf("}}", start + 2);
	if (close === -1) return null;
	return { name: source.slice(start + 2, close), end: close + 2 };
};

// ==[HUMAN APPROVED]== Expands macros in authored text in one left-to-right pass. Recognized
// macros expand to their context value (never rescanned); `\{{name}}` before
// a recognized macro renders the macro literally; unknown `{{...}}` stays
// literal and is reported as a warning labeled by the caller.
export function expandText(
	source: string,
	context: MacroContext,
	blockLabel: string,
): ExpansionResult {
	const warnings: PromptWarning[] = [];
	let output = "";
	let index = 0;

	while (index < source.length) {
		const char = source[index];

		if (char === "\\") {
			const next = source[index + 1];
			if (next === "\\") {
				output += "\\";
				index += 2;
				continue;
			}
			const escaped = matchMacro(source, index + 1);
			if (escaped !== null && recognize(escaped.name, context) !== null) {
				output += `{{${escaped.name}}}`;
				index = escaped.end;
				continue;
			}
			output += "\\";
			index += 1;
			continue;
		}

		const macro = char === "{" ? matchMacro(source, index) : null;
		if (macro !== null) {
			const expanded = recognize(macro.name, context);
			if (expanded !== null) {
				output += expanded;
			} else {
				warnings.push({ block: blockLabel, macro: `{{${macro.name}}}` });
				output += `{{${macro.name}}}`;
			}
			index = macro.end;
			continue;
		}

		output += char;
		index += 1;
	}

	return { text: output, warnings };
}

// ==[HUMAN APPROVED]== Compiles one authored opening with the owner's macro context. The position
// is the one-based ordered position used to label warnings.
export function compileOpening(
	content: string,
	context: MacroContext,
	position: number,
): ExpansionResult {
	return expandText(content, context, `opening ${position}`);
}

const expandInto = (
	blocks: PromptBlock[],
	warnings: PromptWarning[],
	block: PromptBlock,
	text: string,
	context: MacroContext,
	blockLabel: string,
) => {
	if (text === "") return;
	const expanded = expandText(text, context, blockLabel);
	blocks.push({ ...block, content: expanded.text });
	warnings.push(...expanded.warnings);
};

export function compilePrompt(input: CompilePromptInput): PromptPlan {
	const blocks: PromptBlock[] = [];
	const warnings: PromptWarning[] = [];

	const humanContext: MacroContext = {
		self: input.human.name,
		other: input.model.name,
	};
	const modelContext: MacroContext = {
		self: input.model.name,
		other: input.human.name,
	};

	expandInto(
		blocks,
		warnings,
		{ kind: channelBlockKinds.systemInstruction, content: "" },
		input.model.prompt.systemInstruction,
		modelContext,
		"system-instruction",
	);

	expandInto(
		blocks,
		warnings,
		{ kind: channelBlockKinds.identity, role: "human", content: "" },
		input.human.prompt.identity,
		humanContext,
		"identity (human)",
	);

	expandInto(
		blocks,
		warnings,
		{ kind: channelBlockKinds.identity, role: "model", content: "" },
		input.model.prompt.identity,
		modelContext,
		"identity (model)",
	);

	expandInto(
		blocks,
		warnings,
		{ kind: channelBlockKinds.scenario, content: "" },
		input.model.prompt.scenario,
		modelContext,
		"scenario",
	);

	expandInto(
		blocks,
		warnings,
		{ kind: channelBlockKinds.exampleDialogue, content: "" },
		input.model.prompt.exampleDialogue,
		modelContext,
		"example-dialogue",
	);

	for (const entry of input.history ?? []) {
		blocks.push({
			kind: "history",
			speakerName: entry.speakerName,
			content: entry.content,
		});
	}

	expandInto(
		blocks,
		warnings,
		{ kind: channelBlockKinds.postHistoryInstruction, content: "" },
		input.model.prompt.postHistoryInstruction,
		modelContext,
		"post-history-instruction",
	);

	return { blocks, warnings };
}