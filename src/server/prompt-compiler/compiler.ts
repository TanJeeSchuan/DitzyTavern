// ==[HUMAN APPROVED]== Deterministic Prompt compilation.
//
// Block order is the selected Prompt Preset's recipe, not a fixed sequence:
// the compiler walks the recipe's enabled slots in order and resolves each
// Referenced Prompt Block against the Definitions and selected history it was
// given, and expands each authored instruction block's own text. Empty blocks
// are omitted from the rendered plan only — storage keeps exact text.
//
// Macro expansion, Prompt Comments, and escaping are owned by the shared
// shared macro engine; this module supplies only the macro context
// each provenance establishes. A Definition slot expands relative to its
// owner; an authored instruction block always resolves `{{self}}` to the
// current human-controlled Participant and `{{other}}` to the current
// model-controlled Participant. Unknown macros remain literal and become
// prompt-inspection warnings.

import {
	createMacroAttemptState,
	expandMacroText,
	type AttemptEnvironment,
	type MacroAttemptState,
	type MacroEnvironment,
	type MacroExpansionResult,
} from "../../shared/prompt-macro-engine";
import type { MacroContext } from "../../shared/prompt-macros";
import type { PromptChannels } from "../../shared/contract/prompt-schema";
import {
	type PromptOutgoingRole,
	type ReferencedDefinitionBlock,
} from "../../shared/contract/prompt-preset";
import type {
	CompilePromptDefinition,
	CompilePromptInput,
	PromptBlock,
	PromptPlan,
	PromptWarning,
	PromptLoreEntry,
} from "./types";

// ==[HUMAN APPROVED]== Everything a Definition-sourced plan block carries apart from its resolved
// content and outgoing role: the plan kind the recipe slot compiles into. The
// other fields arrive from the slot at push time.
type DefinitionBlock = Exclude<PromptBlock, { kind: "history" }>;
type DefinitionBlockFraming = { kind: DefinitionBlock["kind"] };

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
		block: { kind: "identity" },
		label: "identity (human)",
	},
	"model-identity": {
		owner: "model",
		channel: "identity",
		block: { kind: "identity" },
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
		block: DefinitionBlockFraming;
		label: string;
	}
>;

// ==[HUMAN APPROVED]== The recipe's outgoing role is the author-chosen presentation in the
// shared contract's dropdown vocabulary; the plan keeps the established
// provider-neutral role words, so the Model Client keeps owning the
// translation into provider vocabulary, exactly as it does for history.
const planRoleFor = {
	system: "system",
	user: "human",
	assistant: "model",
} as const satisfies Record<PromptOutgoingRole, "system" | "human" | "model">;

const loreText = (entries: readonly PromptLoreEntry[]): string =>
	entries.map((entry) => entry.content).filter((content) => content.length > 0).join("\n\n");

// ==[HUMAN APPROVED]== Compiles one authored opening with the owner's macro context. The position
// is the one-based ordered position used to label warnings.
export function compileOpening(
	content: string,
	context: MacroContext,
	position: number,
	attempt?: AttemptEnvironment,
): MacroExpansionResult {
	const environment = attempt?.environment ?? { self: context.self, other: context.other };
	const state = attempt?.state ?? createMacroAttemptState();
	state.macroPositionBase = `opening:${position}`;
	return expandMacroText(
		content,
		{ ...environment, self: context.self, other: context.other },
		state,
		`opening ${position}`,
	);
}

const expandInto = (
	blocks: PromptBlock[],
	warnings: PromptWarning[],
	block: DefinitionBlockFraming,
	role: "system" | "human" | "model",
	text: string,
	context: MacroContext,
	blockLabel: string,
	macroEnvironment: MacroEnvironment | undefined,
	macroAttemptState: MacroAttemptState,
	cacheKey: string,
) => {
	// ==[HUMAN APPROVED]== Emptiness is judged after expansion, so a channel holding nothing but a
	// Prompt Comment is omitted exactly like an unauthored one.
	let expanded: MacroExpansionResult;
	const cached = macroAttemptState.expansionCache.get(cacheKey);
	if (cached !== undefined) expanded = cached;
	else {
		macroAttemptState.macroPositionBase = cacheKey;
		expanded = expandMacroText(
			text,
			{ ...(macroEnvironment ?? { self: context.self, other: context.other }), self: context.self, other: context.other },
			macroAttemptState,
			blockLabel,
		);
		macroAttemptState.expansionCache.set(cacheKey, expanded);
	}
	if (expanded.text === "") return;
	blocks.push({ ...block, role, content: expanded.text });
	warnings.push(...expanded.warnings);
};

export function compilePrompt(input: CompilePromptInput): PromptPlan {
	if (input.recipe.filter((slot) => slot.reference === "lore").length > 1) {
		throw new Error("A Prompt Preset may contain at most one Lore block.");
	}
	if (input.recipe.filter((slot) => slot.reference === "memory").length > 1) {
		throw new Error("A Prompt Preset may contain at most one Memory block.");
	}
	const blocks: PromptBlock[] = [];
	const warnings: PromptWarning[] = [];
	const macroEnvironment: MacroEnvironment = input.attempt?.environment ?? { self: "", other: "" };
	const macroAttemptState = input.attempt?.state ?? createMacroAttemptState();

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

	for (const [slotIndex, slot] of input.recipe.entries()) {
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
		if (slot.reference === "lore") {
			const content = loreText(input.lore ?? []);
			if (content.length > 0) {
				blocks.push({ kind: "lore", role: planRoleFor[slot.role], content });
			}
			continue;
		}
		if (slot.reference === "memory") continue;
		if (slot.reference === "instruction") {
			// ==[HUMAN APPROVED]== Authored preset text resolves `{{self}}` to the current
			// human-controlled Participant and `{{other}}` to the current
			// model-controlled Participant, whatever outgoing role the block
			// presents with — the role never changes either perspective. The
			// expansion uses the shared processor, so Prompt Comments and
			// escaping behave exactly as they do in Participant fields.
			expandInto(
				blocks,
				warnings,
				{ kind: "instruction" },
				planRoleFor[slot.role],
				slot.content,
				{ self: input.human.name, other: input.model.name },
				slot.name === "" ? "instruction" : slot.name,
				macroEnvironment,
				macroAttemptState,
				`slot:${slotIndex}`,
			);
			continue;
		}
		const referenced = referencedDefinitionBlocks[slot.reference];
		const owner = definitions[referenced.owner];
		expandInto(
			blocks,
			warnings,
			referenced.block,
			planRoleFor[slot.role],
			owner.definition.prompt[referenced.channel],
			owner.context,
			referenced.label,
			macroEnvironment,
			macroAttemptState,
			`slot:${slotIndex}`,
		);
	}

	return { blocks, warnings };
}
