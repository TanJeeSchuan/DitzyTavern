import { describe, expect, test } from "bun:test";
import {
	createPanelCoordinationState,
	reducePanelCoordination,
} from "./panel-coordination";

describe("panel coordination", () => {
	test("assembly entry closes existing panels", () => {
		const state = reducePanelCoordination(
			{
				...createPanelCoordinationState(),
				primaryPanel: "cast",
				inspector: "generation",
				detailsSurface: "chat-info",
			},
			{ type: "assembly-entered" },
		);

		expect(state.primaryPanel).toBeNull();
		expect(state.inspector).toBeNull();
		expect(state.detailsSurface).toBeNull();
	});
});
