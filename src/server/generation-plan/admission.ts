import { isBoxReference, type PromptBoxReference } from "../../shared/contract/box";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type { BoxAdmission } from "../../shared/contract/box-generation";
import type { BlockItem } from "../box/contract";
import type { BoxItems, BoxResults } from "../box/registry";
import { boxItemExpansionKey, measurePromptPlan, promptPlanEstimator, toEstimationTranscript } from "../prompt-compiler";
import type { MacroAttemptState, PromptContextEntry, PromptLoreEntry, PromptPlan } from "../prompt-compiler";

export const estimateDynamicBlockTokens = (
	kind: "lore" | PromptBoxReference,
	role: "system" | "human" | "model",
	content: string,
	estimator: (transcript: string) => number = promptPlanEstimator,
): number => content.length === 0 ? 0 : Math.max(0,
	Math.ceil(estimator(toEstimationTranscript({ blocks: [{ kind, role, content }], warnings: [], images: [] })))
	- Math.ceil(estimator(toEstimationTranscript({ blocks: [], warnings: [], images: [] }))));

type Admission<Candidate> = { candidate: Candidate; reason: BoxAdmission };
export type LoreBudgetDecision = Admission<PromptLoreEntry>;

// @approved
// Admits candidates in order against an allowance: one alone over it is
// oversized, one that takes the running block over it waits on the
// allowance, one whose trial plan fits is admitted, and the rest meet the
// context limit. `cost` measures a block of candidates; `fits` trials the
// candidates admitted so far with the next one.
const admitWithin = <Candidate>(candidates: readonly Candidate[], allowance: number, cost: (block: readonly Candidate[]) => number, fits: (next: readonly Candidate[]) => boolean) => {
	const admitted: Candidate[] = [];
	const decisions = candidates.map((candidate): Admission<Candidate> => {
		const next = [...admitted, candidate];
		const reason = cost([candidate]) > allowance ? "oversized" : cost(next) > allowance ? "allowance" : fits(next) ? "admitted" : "context-limit";
		if (reason === "admitted") admitted.push(candidate);
		return { candidate, reason };
	});
	return { decisions, admitted };
};

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
			const admission = admitWithin(input.lore, input.loreAllowance, (entries) => cost(entries.map((entry) => entry.content).filter(Boolean).join("\n\n")), (next) => fits(trial(next, boxes)));
			loreDecisions.push(...admission.decisions);
			lore.push(...admission.admitted);
			continue;
		}
		const reference = slot.reference;
		const result = input.boxes[reference];
		if (result === undefined) continue;
		type Item = NonNullable<BoxItems[PromptBoxReference]>[number];
		const expanded = (item: Item) => item.literal === true ? item.text : input.expansions.get(boxItemExpansionKey(slotIndex, item.index))?.text ?? "";
		// @approved
		// The block text the compiler would render: an empty expansion drops out, a literal item never does.
		const block = (entries: readonly Item[]) => {
			const content = entries.filter((item) => item.literal === true || expanded(item) !== "").map(expanded).join("\n\n");
			return content.trim() === "" ? "" : content;
		};
		const pinned = boxes[reference] ?? [];
		// @approved
		// Each item's admission, in the Box's order; pinned items are always admitted.
		const blockDecisions = result.items.map((): BoxAdmission => "admitted");
		decisions[reference] = blockDecisions;
		const unpinned = (items[reference] ?? []).filter((item) => !item.pinned);
		const admission = admitWithin(unpinned, result.allowance ?? Infinity, (entries) => cost(block(entries)), (next) => fits(trial(lore, { ...boxes, [reference]: [...pinned, ...next] })));
		for (const { candidate, reason } of admission.decisions) blockDecisions[candidate.index] = reason;
		boxes[reference] = [...pinned, ...admission.admitted];
	}
	return { lore: { selected: lore, decisions: loreDecisions }, boxes, decisions };
};
