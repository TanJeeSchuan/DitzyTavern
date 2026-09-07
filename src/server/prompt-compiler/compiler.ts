// ==[HUMAN APPROVED]== Deterministic Prompt compilation.
//
// Block order is the selected Prompt Preset's recipe, not a fixed sequence:
// the compiler walks the recipe's enabled slots in order and resolves each
// Referenced Prompt Block against the Definitions and selected history it was
// given. Empty blocks are omitted from the rendered plan only — storage keeps
// exact text.
//
// `{{self}}` and `{{other}}` expand relative to the Definition owner,
// case-sensitively and in one pass; expansion output is never rescanned. A
// backslash escapes a recognized macro (`\{{self}}` renders `{{self}}`).
// Unknown macros remain literal and become prompt-inspection warnings.

import type { PromptChannels } from "../../shared/contract/prompt-schema";
import type { ReferencedDefinitionBlock } from "../../shared/contract/prompt-preset";
import type {
	CompilePromptDefinition,
	CompilePromptInput,
	ExpansionResult,
	MacroContext,
	PromptBlock,
	PromptPlan,
	PromptWarning,
} from "./types";

// ==[HUMAN APPROVED]== Everything a Definition-sourced plan block carries apart from its resolved
// content. Distributing over the block union keeps the identity block's role
// required while the other kinds reject it.
type AuthoredBlock = Exclude<PromptBlock, { kind: "history" }>;
type AuthoredBlockFraming = AuthoredBlock extends infer Block
	? Block extends AuthoredBlock ? Omit<Block, "content"> : never
	: never;

// ==[HUMAN APPROVED]== What each Referenced Prompt Block reads: which controlled Definition owns
// the text, which Prompt channel holds it, the plan block it compiles into,
// and the label its macro warnings carry. The declaration is exhaustive over
// the reference vocabulary, so a reference added to the shared contract fails
// typecheck until this states where its content comes from.
export const referencedDefinitionBlocks = {
	"model-system-instruction": {
		owner: "model",
		channel: "systemInstruction",
		block: { kind: "system-instruction" },
		label: "system-instruction",
	},
	"human-identity": {
		owner: "human",
		channel: "identity",
		block: { kind: "identity", role: "human" },
		label: "identity (human)",
	},
	"model-identity": {
		owner: "model",
		channel: "identity",
		block: { kind: "identity", role: "model" },
		label: "identity (model)",
	},
	"model-scenario": {
		owner: "model",
		channel: "scenario",
		block: { kind: "scenario" },
		label: "scenario",
	},
	"model-example-dialogue": {
		owner: "model",
		channel: "exampleDialogue",
		block: { kind: "example-dialogue" },
		label: "example-dialogue",
	},
	"model-post-history-instruction": {
		owner: "model",
		channel: "postHistoryInstruction",
		block: { kind: "post-history-instruction" },
		label: "post-history-instruction",
	},
} as const satisfies Record<
	ReferencedDefinitionBlock,
	{
		owner: "human" | "model";
		channel: keyof PromptChannels;
		block: AuthoredBlockFraming;
		label: string;
	}
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

	// ==[HUMAN APPROVED]== Owner-relative macro context: `{{self}}` is the Definition owner and
	// `{{other}}` the other controlled Participant, whatever order the recipe
	// places their slots in.
	const definitions = {
		human: {
			definition: input.human,
			context: { self: input.human.name, other: input.model.name },
		},
		model: {
			definition: input.model,
			context: { self: input.model.name, other: input.human.name },
		},
	} satisfies Record<
		"human" | "model",
		{ definition: CompilePromptDefinition; context: MacroContext }
	>;

	for (const slot of input.recipe) {
		if (!slot.enabled) continue;
		if (slot.reference === "history") {
			for (const entry of input.context ?? []) {
				blocks.push({
					kind: "history",
					speakerName: entry.speakerName,
					content: entry.content,
					role: entry.role,
				});
			}
			continue;
		}
		const referenced = referencedDefinitionBlocks[slot.reference];
		const owner = definitions[referenced.owner];
		expandInto(
			blocks,
			warnings,
			{ ...referenced.block, content: "" },
			owner.definition.prompt[referenced.channel],
			owner.context,
			referenced.label,
		);
	}

	return { blocks, warnings };
}
