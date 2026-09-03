import { describe, expect, test } from "bun:test";
import {
	createPanelCoordinationState,
	reducePanelCoordination,
} from "./panel-coordination";

describe("panel coordination", () => {
	test("opens only the matching inspector beside its left panel", () => {
		let state = createPanelCoordinationState();
		state = reducePanelCoordination(state, { type: "primary-opened", panel: "generation" });
		state = reducePanelCoordination(state, { type: "inspector-opened", inspector: "generation" });

		expect(state.primaryPanel).toBe("generation");
		expect(state.inspector).toBe("generation");
		const unchanged = reducePanelCoordination(state, { type: "inspector-opened", inspector: "models" });
		expect(unchanged).toBe(state);
	});

	test("closing or replacing the left panel closes its split inspector", () => {
		let state = createPanelCoordinationState();
		state = reducePanelCoordination(state, { type: "primary-opened", panel: "models" });
		state = reducePanelCoordination(state, { type: "inspector-opened", inspector: "models" });
		state = reducePanelCoordination(state, { type: "primary-opened", panel: "cast" });

		expect(state.primaryPanel).toBe("cast");
		expect(state.inspector).toBeNull();
	});

	test("details surfaces and Preview mode close the split inspector", () => {
		let state = createPanelCoordinationState();
		state = reducePanelCoordination(state, { type: "primary-opened", panel: "generation" });
		state = reducePanelCoordination(state, { type: "inspector-opened", inspector: "generation" });
		state = reducePanelCoordination(state, { type: "chat-info-opened" });
		expect(state).toMatchObject({
			primaryPanel: null,
			inspector: null,
			detailsSurface: "chat-info",
		});

		state = reducePanelCoordination(state, { type: "primary-opened", panel: "models" });
		state = reducePanelCoordination(state, { type: "inspector-opened", inspector: "models" });
		state = reducePanelCoordination(state, { type: "preview-entered" });
		expect(state).toMatchObject({
			primaryPanel: null,
			inspector: null,
			detailsSurface: null,
			previewMode: true,
		});
	});
});
