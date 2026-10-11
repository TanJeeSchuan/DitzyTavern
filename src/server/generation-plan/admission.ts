import { isBoxReference, type PromptBoxReference } from "../../shared/contract/box";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type { BlockItem, BoxAdmission } from "../box/contract";
import type { BoxItems, BoxResults } from "../box/registry";
import { toEstimationTranscript, tokenxEstimator, type PromptContextEntry, type PromptLoreEntry, type PromptPlan } from "../prompt-compiler";

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
	const boxes: BoxItems = Object.fromEntries(Object.entries(items).map(([reference, entries]) => [reference, entries.filter((item) => item.pinned)]));
	const decisions: Partial<Record<PromptBoxReference, Map<string, BoxAdmission>>> = {};
	const trial = (trialLore: readonly PromptLoreEntry[], trialBoxes: BoxItems) => input.compile(input.protectedContext, trialLore, trialBoxes);
	const fits = (plan: PromptPlan) => Math.ceil(input.estimator(toEstimationTranscript(plan))) + input.responseBudget + input.safetyAllowance <= input.contextLimit;
	// @approved
	// Expand once in recipe order before admission; budget trials must not reorder or repeat macro writes.
	trial(input.lore, items);
	for (const slot of input.recipe) {
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
		const selected: NonNullable<BoxItems[PromptBoxReference]>[number][] = [];
		const pinned = boxes[reference] ?? [];
		const blockDecisions = new Map<string, BoxAdmission>();
		decisions[reference] = blockDecisions;
		const expanded = (items: NonNullable<BoxItems[PromptBoxReference]>) => trial(lore, { ...boxes, [reference]: items }).blocks.find((block) => block.kind === reference)?.content ?? "";
		for (const item of (items[reference] ?? []).filter((item) => !item.pinned)) {
			const next = [...selected, item];
			const nextBoxes = { ...boxes, [reference]: [...pinned, ...next] };
			const reason = cost(expanded([item])) > allowance ? "oversized"
				: cost(expanded(next)) > allowance ? "allowance"
					: fits(trial(lore, nextBoxes)) ? "admitted" : "context-limit";
			blockDecisions.set(item.text, reason);
			if (reason === "admitted") { selected.push(item); boxes[reference] = nextBoxes[reference]; }
		}
	}
	return { lore: { selected: lore, decisions: loreDecisions }, boxes, decisions };
};
