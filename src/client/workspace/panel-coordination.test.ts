import { describe, expect, test } from "bun:test";
import {
	createPanelCoordinationState,
	reducePanelCoordination,
} from "./panel-coordination";

const openPromptPlan = () => reducePanelCoordination(
	createPanelCoordinationState(),
	{ type: "prompt-plan-opened" },
);

describe("panel coordination", () => {
	test("keeps a live Prompt Plan visible while other surfaces try to open", () => {
		const state = openPromptPlan();
		const actions = [
			{ type: "chat-info-opened" as const },
			{ type: "macro-variables-opened" as const },
			{ type: "primary-opened" as const, panel: "cast" as const },
			{ type: "inspector-opened" as const, inspector: "generation" as const },
		];

		for (const action of actions) {
			expect(reducePanelCoordination(state, action)).toEqual(state);
		}
	});

	test("closes only the Prompt Plan mode and preserves another detail surface", () => {
		const state = {
			...openPromptPlan(),
			detailsSurface: "chat-info" as const,
		};
		const closed = reducePanelCoordination(state, { type: "prompt-plan-closed" });

		expect(closed.promptPlanOpen).toBe(false);
		expect(closed.detailsSurface).toBe("chat-info");
	});

	test("Prompt Plan opening is exclusive with existing panels", () => {
		const state = reducePanelCoordination(
			{
				...createPanelCoordinationState(),
				primaryPanel: "cast",
				inspector: "generation",
				detailsSurface: "chat-info",
			},
			{ type: "prompt-plan-opened" },
		);

		expect(state.primaryPanel).toBeNull();
		expect(state.inspector).toBeNull();
		expect(state.detailsSurface).toBe("prompt-plan");
		expect(state.promptPlanOpen).toBe(true);
	});
});
