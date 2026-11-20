import { requestVariantSelection, type VariantSelectionSurface } from "../variant-selection";

export function usePreviewController(surface: VariantSelectionSurface) {
	const { story, dispatchStory } = surface;
	const cancelPreview = () => dispatchStory({ type: "preview-changed", preview: null });
	const confirmPreview = async () => {
		const preview = story.preview;
		if (preview !== null) await requestVariantSelection(surface, preview.messageId, preview.variantId, true);
	};
	return { cancelPreview, confirmPreview };
}
