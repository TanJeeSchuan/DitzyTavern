// @approved
//  Deterministic Prompt compilation.
// Block order is the selected Prompt Preset's recipe, not a fixed sequence:
// the compiler walks the recipe's enabled slots in order and resolves each
// Referenced Prompt Block against the Definitions and selected history it was
// given, and expands each authored instruction block's own text. Empty blocks
// are omitted from the rendered plan only — storage keeps exact text.
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
	isBoxSlot,
	repeatedSingleUseReference,
	singleUseReferenceLabel,
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
import { resolvePromptImages } from "./images";
import { boxDescriptor, boxIdOf } from "../../shared/contract/box";

// @approved
//  Everything a Definition-sourced plan block carries apart from its resolved
// content and outgoing role: the plan kind the recipe slot compiles into. The
// other fields arrive from the slot at push time.
type DefinitionBlock = Exclude<PromptBlock, { kind: "history" }>;
type DefinitionBlockFraming = { kind: DefinitionBlock["kind"] };

// @approved
//  What each Referenced Prompt Block reads: which controlled Definition owns
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

// @approved
//  The recipe's outgoing role is the author-chosen presentation in the
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

// @approved
//  Compiles one authored opening with the owner's macro context. The position
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

const expandInto = (request: {
	blocks: PromptBlock[];
	warnings: PromptWarning[];
	block: DefinitionBlockFraming;
	role: "system" | "human" | "model";
	text: string;
	context: MacroContext;
	blockLabel: string;
	macroEnvironment: MacroEnvironment | undefined;
	macroAttemptState: MacroAttemptState;
	cacheKey: string;
	beforeHistory: boolean;
}) => {
	const { blocks, warnings, block, role, text, context, blockLabel, macroEnvironment, macroAttemptState, cacheKey, beforeHistory } = request;
	// @approved
	//  Emptiness is judged after expansion, so a channel holding nothing but a
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
	if (beforeHistory) warnings.push(...expanded.changing.map((macro) => ({ block: blockLabel, macro, reason: "uncached" as const })));
};

// @approved
//  Strict System Placement sends one leading run of system messages. System
// blocks before history are static context, so they move to the front; a
// system block after any other message keeps its place, for recency, and is
// sent as a human message marked demoted.
const placeStrictly = (blocks: readonly PromptBlock[], historyStart: number): PromptBlock[] => {
	const preHistory = blocks.slice(0, historyStart);
	let dialogue = false;
	return [
		...preHistory.filter((block) => block.role === "system"),
		...preHistory.filter((block) => block.role !== "system"),
		...blocks.slice(historyStart),
	].map((block) => {
		if (block.role !== "system") dialogue = true;
		return dialogue && block.role === "system" ? { ...block, role: "human", demoted: true } : block;
	});
};

/** @approved Where a Box item's one expansion is kept in the attempt, so admission reads it instead of recompiling. */
export const boxItemExpansionKey = (slotIndex: number, itemIndex: number) => `slot:${slotIndex}:item:${itemIndex}`;

export function compilePrompt(input: CompilePromptInput): PromptPlan {
	const repeated = repeatedSingleUseReference(input.recipe.map((slot) => slot.reference));
	if (repeated !== undefined) throw new Error(`A Prompt Preset may contain at most one ${singleUseReferenceLabel(repeated)} block.`);
	const blocks: PromptBlock[] = [];
	const warnings: PromptWarning[] = [];
	const macroEnvironment: MacroEnvironment = input.attempt?.environment ?? { self: "", other: "" };
	const macroAttemptState = input.attempt?.state ?? createMacroAttemptState();
	let historyStart: number | undefined;
	const historySlot = input.recipe.findIndex((slot) => slot.enabled && slot.reference === "history");

	// @approved
	//  Owner-relative macro context: `{{self}}` is the Definition owner and
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
			historyStart ??= blocks.length;
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
		if (isBoxSlot(slot)) {
			const kind = slot.reference;
			// @approved
			//  A Box block is its instructions, expanded like authored preset
			// text, then the Box's items. A Box that ran with no items renders
			// nothing, so its instructions never stand alone, unless it
			// declares `alwaysRender`; a Box that did not run, or is not
			// loaded, renders nothing.
			const items = input.boxes[kind];
			if (items === undefined) continue;
			const alwaysRender = boxDescriptor(boxIdOf(kind)).alwaysRender === true;
			if (items.length === 0 && !alwaysRender) continue;
			const role = planRoleFor[slot.role];
			const blockLabel = singleUseReferenceLabel(kind);
			const context = { self: input.human.name, other: input.model.name };
			const blockWarnings: PromptWarning[] = [];
			const expand = (into: PromptBlock[], text: string, cacheKey: string) =>
				expandInto({ blocks: into, warnings: blockWarnings, block: { kind }, role, text, context, blockLabel, macroEnvironment, macroAttemptState, cacheKey, beforeHistory: slotIndex < historySlot });
			const instructions: PromptBlock[] = [];
			expand(instructions, slot.content, `slot:${slotIndex}`);
			const expanded: PromptBlock[] = [];
			for (const item of items) if (item.literal === true) expanded.push({ kind, role, content: item.text }); else expand(expanded, item.text, boxItemExpansionKey(slotIndex, item.index));
			const content = expanded.map((block) => block.content).join("\n\n");
			if (content.trim() === "" && !alwaysRender) continue;
			const rendered = [...instructions.map((block) => block.content), content].filter((part) => part.trim() !== "").join("\n");
			if (rendered === "") continue;
			blocks.push({ kind, role, content: rendered });
			warnings.push(...blockWarnings);
			continue;
		}
		if (slot.reference === "instruction") {
			// @approved
			//  Authored preset text resolves `{{self}}` to the current
			// human-controlled Participant and `{{other}}` to the current
			// model-controlled Participant, whatever outgoing role the block
			// presents with — the role never changes either perspective. The
			// expansion uses the shared processor, so Prompt Comments and
			// escaping behave exactly as they do in Participant fields.
			expandInto({
				blocks,
				warnings,
				block: { kind: "instruction" },
				role: planRoleFor[slot.role],
				text: slot.content,
				context: { self: input.human.name, other: input.model.name },
				blockLabel: slot.name === "" ? "instruction" : slot.name,
				macroEnvironment,
				macroAttemptState,
				cacheKey: `slot:${slotIndex}`,
				beforeHistory: slotIndex < historySlot,
			});
			continue;
		}
		const referenced = referencedDefinitionBlocks[slot.reference];
		const owner = definitions[referenced.owner];
		expandInto({
			blocks,
			warnings,
			block: referenced.block,
			role: planRoleFor[slot.role],
			text: owner.definition.prompt[referenced.channel],
			context: owner.context,
			blockLabel: referenced.label,
			macroEnvironment,
			macroAttemptState,
			cacheKey: `slot:${slotIndex}`,
			beforeHistory: slotIndex < historySlot,
		});
	}

	const placed = input.systemPlacement === "strict" ? placeStrictly(blocks, historyStart ?? blocks.length) : blocks;
	return resolvePromptImages({ blocks: placed, warnings }, input.images);
}
