import type { GenerationDetailsTarget } from "../GenerationDetailsPanel";
import type { PrimaryPanel, PrimaryPanelName } from "./types";

export type SplitInspector = "generation";
export type DetailsSurface = "chat-info" | "generation-details" | "macro-variables" | "memories";

export interface PanelCoordinationState {
	primaryPanel: PrimaryPanel;
	inspector: SplitInspector | null;
	detailsSurface: DetailsSurface | null;
	previewMode: boolean;
	generationDetailsTarget: GenerationDetailsTarget | null;
	memoryFocus: { messageId: number } | null;
}

export type PanelCoordinationAction =
	| { type: "primary-toggled"; panel: PrimaryPanelName }
	| { type: "primary-opened"; panel: PrimaryPanelName }
	| { type: "primary-closed" }
	| { type: "inspector-opened"; inspector: SplitInspector }
	| { type: "inspector-closed" }
	| { type: "chat-info-opened" }
	| { type: "generation-details-opened"; target: GenerationDetailsTarget }
	| { type: "macro-variables-opened" }
	| { type: "memories-opened"; focus: { messageId: number } | null }
	| { type: "details-closed" }
	| { type: "preview-entered" }
	| { type: "preview-exited" }
	| { type: "workspace-reset" };

export const createPanelCoordinationState = (): PanelCoordinationState => ({
	primaryPanel: null,
	inspector: null,
	detailsSurface: null,
	previewMode: false,
	generationDetailsTarget: null,
	memoryFocus: null,
});

// Focus and detail targets only outlive their surface while it stays open;
// every action that drops a surface drops the focus data with it.
const dropFocusData = (state: PanelCoordinationState): PanelCoordinationState => ({
	...state,
	generationDetailsTarget: null,
	memoryFocus: null,
});

const openDetailSurface = (
	state: PanelCoordinationState,
	detailsSurface: DetailsSurface,
): PanelCoordinationState => state.previewMode
	? state
	: {
			...dropFocusData(state),
			primaryPanel: null,
			inspector: null,
			detailsSurface,
	};

export function reducePanelCoordination(
	state: PanelCoordinationState,
	action: PanelCoordinationAction,
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
			return state.previewMode || state.primaryPanel !== action.inspector
				? state
				: { ...dropFocusData(state), inspector: action.inspector, detailsSurface: null };
		case "inspector-closed":
			return { ...state, inspector: null };
		case "chat-info-opened":
			return openDetailSurface(state, "chat-info");
		case "generation-details-opened":
			return { ...openDetailSurface(state, "generation-details"), generationDetailsTarget: action.target };
		case "macro-variables-opened":
			return openDetailSurface(state, "macro-variables");
		case "memories-opened":
			return { ...openDetailSurface(state, "memories"), memoryFocus: action.focus };
		case "details-closed":
			return { ...dropFocusData(state), detailsSurface: null };
		case "preview-entered":
			return {
				...dropFocusData(state),
				previewMode: true,
				primaryPanel: null,
				inspector: null,
				detailsSurface: null,
			};
		case "preview-exited":
			return { ...state, previewMode: false };
		case "workspace-reset":
			return { ...dropFocusData(state), primaryPanel: null, inspector: null, detailsSurface: null };
	}
}
