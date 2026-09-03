import type { PrimaryPanel } from "./types";

export type SplitInspector = "generation" | "models";
export type DetailsSurface = "chat-info" | "generation-details";

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
			return { ...state, primaryPanel: null, inspector: null };
		case "inspector-opened":
			return state.previewMode || state.primaryPanel !== action.inspector
				? state
				: { ...state, inspector: action.inspector, detailsSurface: null };
		case "inspector-closed":
			return { ...state, inspector: null };
		case "chat-info-opened":
			if (state.previewMode) return state;
			return {
				...state,
				primaryPanel: null,
				inspector: null,
				detailsSurface: "chat-info",
			};
		case "generation-details-opened":
			if (state.previewMode) return state;
			return {
				...state,
				primaryPanel: null,
				inspector: null,
				detailsSurface: "generation-details",
			};
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
