import { boxReference, type PromptBoxReference } from "../../shared/contract/box";
import type { GenerationDetailsTarget } from "../GenerationDetailsPanel";
import type { PrimaryPanel, PrimaryPanelName } from "./types";

export type SplitInspector = "generation";
export type DetailsSurface = "paint" | "chat-info" | "generation-details" | "macro-variables" | PromptBoxReference;

export interface PanelCoordinationState {
	primaryPanel: PrimaryPanel;
	inspector: SplitInspector | null;
	detailsSurface: DetailsSurface | null;
	generationDetailsTarget: GenerationDetailsTarget | null;
	paintVariantId: number | null;
	boxFocus: { messageId: number } | null;
}

export type PanelCoordinationAction =
	| { type: "primary-toggled"; panel: PrimaryPanelName }
	| { type: "primary-opened"; panel: PrimaryPanelName }
	| { type: "primary-closed" }
	| { type: "inspector-opened"; inspector: SplitInspector }
	| { type: "inspector-closed" }
	| { type: "chat-info-opened" }
	| { type: "paint-opened"; variantId: number }
	| { type: "generation-details-opened"; target: GenerationDetailsTarget }
	| { type: "macro-variables-opened" }
	| { type: "box-inspector-opened"; box: string; focus: { messageId: number } | null }
	| { type: "details-closed" }
	| { type: "preview-entered" }
	| { type: "workspace-reset" };

export const createPanelCoordinationState = (): PanelCoordinationState => ({
	primaryPanel: null,
	inspector: null,
	detailsSurface: null,
	generationDetailsTarget: null,
	paintVariantId: null,
	boxFocus: null,
});

// @approved
// Focus and detail targets only outlive their surface while it stays open;
// every action that drops a surface drops the focus data with it.
const dropFocusData = (state: PanelCoordinationState): PanelCoordinationState => ({
	...state,
	generationDetailsTarget: null,
	paintVariantId: null,
	boxFocus: null,
});

const openDetailSurface = (
	state: PanelCoordinationState,
	detailsSurface: DetailsSurface,
	preview: boolean,
): PanelCoordinationState => preview
	? state
	: {
			...dropFocusData(state),
			primaryPanel: null,
			inspector: null,
			detailsSurface,
	};

// @approved
//  `preview` is whether the story shows a Swipe preview, which owns that
// state; while it does, inspectors and detail surfaces stay closed.
export function reducePanelCoordination(
	state: PanelCoordinationState,
	action: PanelCoordinationAction,
	preview: boolean,
): PanelCoordinationState {
	switch (action.type) {
		case "primary-toggled": {
			const primaryPanel = state.primaryPanel === action.panel ? null : action.panel;
			return {
				...dropFocusData(state),
				primaryPanel,
				inspector: null,
				detailsSurface: null,
			};
		}
		case "primary-opened":
			return {
				...dropFocusData(state),
				primaryPanel: action.panel,
				inspector: null,
				detailsSurface: null,
			};
		case "primary-closed":
			return { ...dropFocusData(state), primaryPanel: null, inspector: null, detailsSurface: null };
		case "inspector-opened":
			return preview || state.primaryPanel !== action.inspector
				? state
				: { ...dropFocusData(state), inspector: action.inspector, detailsSurface: null };
		case "inspector-closed":
			return { ...state, inspector: null };
		case "paint-opened":
			return { ...openDetailSurface(state, "paint", preview), paintVariantId: action.variantId };
		case "chat-info-opened":
			return openDetailSurface(state, "chat-info", preview);
		case "generation-details-opened":
			return { ...openDetailSurface(state, "generation-details", preview), generationDetailsTarget: action.target };
		case "macro-variables-opened":
			return openDetailSurface(state, "macro-variables", preview);
		case "box-inspector-opened":
			return preview ? state : { ...openDetailSurface(state, boxReference(action.box), preview), boxFocus: action.focus };
		case "details-closed":
			return { ...dropFocusData(state), detailsSurface: null };
		case "preview-entered":
			return {
				...dropFocusData(state),
				primaryPanel: null,
				inspector: null,
				detailsSurface: null,
			};
		case "workspace-reset":
			return { ...dropFocusData(state), primaryPanel: null, inspector: null, detailsSurface: null };
	}
}
