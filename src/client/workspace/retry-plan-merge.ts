import type { PromptPlan } from "../../shared/contract/conversation-schema";

export const transferRetainedEdits = (
	assembled: PromptPlan,
	edited: PromptPlan,
	fresh: PromptPlan,
): PromptPlan | null => {
	const compatible =
		JSON.stringify(assembled.blocks) === JSON.stringify(fresh.blocks) &&
		JSON.stringify(assembled.intent ?? null) === JSON.stringify(fresh.intent ?? null);
	return compatible ? { ...fresh, blocks: edited.blocks } : null;
};
