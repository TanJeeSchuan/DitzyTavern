export interface AssemblyGateInput {
	playable: boolean;
	isGenerating: boolean;
	assemblyActive: boolean;
	variantPreviewActive: boolean;
}

export const canStartAssembly = ({
	playable,
	isGenerating,
	assemblyActive,
	variantPreviewActive,
}: AssemblyGateInput): boolean =>
	playable &&
	!isGenerating &&
	!assemblyActive &&
	!variantPreviewActive;
