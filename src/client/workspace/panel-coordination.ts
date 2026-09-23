import type { PrimaryPanel } from "./types";

export type SplitInspector = "generation" | "models";
export type DetailsSurface = "chat-info" | "generation-details" | "macro-variables" | "memories";

export interface PanelCoordinationState {
	primaryPanel: PrimaryPanel;
	inspector: SplitInspector | null;
	detailsSurface: DetailsSurface | null;
	previewMode: boolean;
}

export type PanelCoordinationAction =
	| { type: "primary-toggled"; panel: Exclude<PrimaryPanel, null> }
	| { type: "primary-opened"; panel: Exclude<PrimaryPanel, null> }
	| { type: "primary-closed" }
	| { type: "inspector-opened"; inspector: SplitInspector }
	| { type: "inspector-closed" }
	| { type: "chat-info-opened" }
	| { type: "generation-details-opened" }
	| { type: "macro-variables-opened" }
	| { type: "memories-opened" }
	| { type: "details-closed" }
	| { type: "preview-entered" }
	| { type: "preview-exited" }
	| { type: "workspace-reset" };

export const createPanelCoordinationState = (): PanelCoordinationState => ({
	primaryPanel: null,
	inspector: null,
	detailsSurface: null,
	previewMode: false,
});

const openDetailSurface = (
	state: PanelCoordinationState,
	detailsSurface: DetailsSurface,
): PanelCoordinationState => state.previewMode
	? state
	: {
			...state,
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
				...state,
				primaryPanel,
				inspector: null,
				detailsSurface: null,
			};
		}
		case "primary-opened":
			return {
				...state,
				primaryPanel: action.panel,
				inspector: null,
				detailsSurface: null,
			};
		case "primary-closed":
			return { ...state, primaryPanel: null, inspector: null, detailsSurface: null };
		case "inspector-opened":
			return state.previewMode || state.primaryPanel !== action.inspector
				? state
				: { ...state, inspector: action.inspector, detailsSurface: null };
		case "inspector-closed":
			return { ...state, inspector: null };
		case "chat-info-opened":
			return openDetailSurface(state, "chat-info");
		case "generation-details-opened":
			return openDetailSurface(state, "generation-details");
		case "macro-variables-opened":
			return openDetailSurface(state, "macro-variables");
		case "memories-opened":
			return openDetailSurface(state, "memories");
		case "details-closed":
			return { ...state, detailsSurface: null };
		case "preview-entered":
			return {
				...state,
				previewMode: true,
				primaryPanel: null,
				inspector: null,
				detailsSurface: null,
			};
		case "preview-exited":
			return { ...state, previewMode: false };
		case "workspace-reset":
			return { ...state, primaryPanel: null, inspector: null, detailsSurface: null };
	}
}
