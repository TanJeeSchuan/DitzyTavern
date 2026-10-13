import { isBoxReference, type PromptBoxReference } from "../../shared/contract/box";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type { BoxAdmission } from "../../shared/contract/box-generation";
import type { BlockItem } from "../box/contract";
import type { BoxItems, BoxResults } from "../box/registry";
import { boxItemExpansionKey, measurePromptPlan, toEstimationTranscript, tokenxEstimator, type MacroAttemptState, type PromptContextEntry, type PromptLoreEntry, type PromptPlan } from "../prompt-compiler";

export const estimateDynamicBlockTokens = (
	kind: "lore" | PromptBoxReference,
	role: "system" | "human" | "model",
	content: string,
	estimator: (transcript: string) => number = tokenxEstimator,
): number => content.length === 0 ? 0 : Math.max(0,
	Math.ceil(estimator(toEstimationTranscript({ blocks: [{ kind, role, content }], warnings: [], images: [] })))
	- Math.ceil(estimator(toEstimationTranscript({ blocks: [], warnings: [], images: [] }))));

export type LoreBudgetDecision = { candidate: PromptLoreEntry; reason: BoxAdmission };

export const admitDynamicBlocks = (input: {
	recipe: readonly PromptPresetSlot[];
	lore: readonly PromptLoreEntry[];
	boxes: BoxResults;
	loreAllowance: number;
	compile: (context: readonly PromptContextEntry[], lore: readonly PromptLoreEntry[], boxes: BoxItems) => PromptPlan;
	expansions: MacroAttemptState["expansionCache"];
	protectedContext: readonly PromptContextEntry[];
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	estimator: (transcript: string) => number;
}) => {
	const lore: PromptLoreEntry[] = [];
	const loreDecisions: LoreBudgetDecision[] = [];
	const admissionOrder = (left: BlockItem, right: BlockItem) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.priority - left.priority;
	const items: BoxItems = Object.fromEntries(Object.entries(input.boxes).map(([reference, result]) =>
		[reference, (result?.items ?? []).map((item, index) => ({ ...item, index })).sort(admissionOrder)]));
	const boxes: BoxItems = Object.fromEntries(Object.entries(items).map(([reference, entries]) => [reference, (entries ?? []).filter((item) => item.pinned)]));
	const decisions: Partial<Record<string, BoxAdmission[]>> = {};
	const trial = (trialLore: readonly PromptLoreEntry[], trialBoxes: BoxItems) => input.compile(input.protectedContext, trialLore, trialBoxes);
	const fits = (plan: PromptPlan) => measurePromptPlan({ plan, contextLimit: input.contextLimit, responseBudget: input.responseBudget, safetyAllowance: input.safetyAllowance, estimator: input.estimator }).fits;
	// @approved
	// The one preparation pass: every item expands once, in recipe order, and
	// admission reads each expansion back, so budget trials never reorder or
	// repeat macro writes. Each trial then measures the whole candidate,
	// Images included, because placement depends on what else is admitted.
	trial(input.lore, items);
	for (const [slotIndex, slot] of input.recipe.entries()) {
		if (!slot.enabled || slot.reference === "history" || (slot.reference !== "lore" && !isBoxReference(slot.reference))) continue;
		const role = slot.role === "system" ? "system" : slot.role === "user" ? "human" : "model";
		const kind = slot.reference;
		const cost = (content: string) => estimateDynamicBlockTokens(kind, role, content, input.estimator);
		if (slot.reference === "lore") {
			for (const candidate of input.lore) {
				const next = [...lore, candidate];
				const reason = cost(candidate.content) > input.loreAllowance ? "oversized"
					: cost(next.map((entry) => entry.content).filter(Boolean).join("\n\n")) > input.loreAllowance ? "allowance"
					: fits(trial(next, boxes)) ? "admitted" : "context-limit";
				loreDecisions.push({ candidate, reason });
				if (reason === "admitted") lore.push(candidate);
			}
			continue;
		}
		const reference = slot.reference;
		const result = input.boxes[reference];
		if (result === undefined) continue;
		const allowance = result.allowance ?? Infinity;
		if (result.allowance !== undefined && (!Number.isInteger(allowance) || allowance < 0)) throw new Error("Box allowance must be a non-negative whole number.");
		type Item = NonNullable<BoxItems[PromptBoxReference]>[number];
		const expanded = (item: Item) => item.literal === true ? item.text : input.expansions.get(boxItemExpansionKey(slotIndex, item.index))?.text ?? "";
		// @approved
		// The block text the compiler would render: an empty expansion drops out, a literal item never does.
		const block = (entries: readonly Item[]) => {
			const content = entries.filter((item) => item.literal === true || expanded(item) !== "").map(expanded).join("\n\n");
			return content.trim() === "" ? "" : content;
		};
		const selected: Item[] = [];
		const pinned = boxes[reference] ?? [];
		// @approved
		// Each item's admission, in the Box's order; pinned items are always admitted.
		const blockDecisions = result.items.map((): BoxAdmission => "admitted");
		decisions[reference] = blockDecisions;
		for (const item of (items[reference] ?? []).filter((item) => !item.pinned)) {
			const next = [...selected, item];
			const nextBoxes: BoxItems = { ...boxes, [reference]: [...pinned, ...next] };
			const reason = cost(block([item])) > allowance ? "oversized"
				: cost(block(next)) > allowance ? "allowance"
					: fits(trial(lore, nextBoxes)) ? "admitted" : "context-limit";
			blockDecisions[item.index] = reason;
			if (reason === "admitted") { selected.push(item); boxes[reference] = nextBoxes[reference]; }
		}
	}
	return { lore: { selected: lore, decisions: loreDecisions }, boxes, decisions };
};
