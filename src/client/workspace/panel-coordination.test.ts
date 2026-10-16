import { expect, test } from "bun:test";
import { createPanelCoordinationState, reducePanelCoordination } from "./panel-coordination";

test("switching Box inspectors replaces message focus and closing drops it", () => {
	const initial = createPanelCoordinationState();
	const focused = reducePanelCoordination(initial, { type: "box-inspector-opened", box: "journal", focus: { messageId: 7 } });
	expect(focused.detailsSurface).toBe("box:journal");
	expect(focused.boxFocus).toEqual({ messageId: 7 });
	const other = reducePanelCoordination(focused, { type: "box-inspector-opened", box: "weather", focus: null });
	expect(other.detailsSurface).toBe("box:weather");
	expect(other.boxFocus).toBeNull();
	const closed = reducePanelCoordination(focused, { type: "details-closed" });
	expect(closed.detailsSurface).toBeNull();
	expect(closed.boxFocus).toBeNull();
});

test("opening a primary panel clears Box focus and a Swipe preview rejects inspector requests", () => {
	const focused = reducePanelCoordination(createPanelCoordinationState(), { type: "box-inspector-opened", box: "journal", focus: { messageId: 7 } });
	const settings = reducePanelCoordination(focused, { type: "primary-opened", panel: "box-settings:journal" });
	expect(settings.detailsSurface).toBeNull();
	expect(settings.boxFocus).toBeNull();
	const preview = reducePanelCoordination(focused, { type: "preview-entered" });
	expect(reducePanelCoordination(preview, { type: "box-inspector-opened", box: "journal", focus: { messageId: 9 } })).toEqual(preview);
});
