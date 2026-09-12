export interface AssemblyGateInput {
	playable: boolean;
	isGenerating: boolean;
	promptPlanOpen: boolean;
	promptPlanPending: boolean;
	variantPreviewActive: boolean;
}

export const canStartAssembly = ({
	playable,
	isGenerating,
	promptPlanOpen,
	promptPlanPending,
	variantPreviewActive,
}: AssemblyGateInput): boolean =>
	playable &&
	!isGenerating &&
	!promptPlanOpen &&
	!promptPlanPending &&
	!variantPreviewActive;
