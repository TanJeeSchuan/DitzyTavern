import { expect, test } from "bun:test";
import { installBoxes, type BoxMetadata } from "../shared/contract/box";
import { boxDelegateClients } from "./box-decision-settings";

const delegating = (id: string): BoxMetadata => ({ id, label: id, summary: "", instructions: "", delegate: { tag: id, summary: "", description: "", off: "Off" } });

test("a delegating Box installed while the app runs joins the delegate settings, and a listed one keeps its load and save", () => {
	installBoxes([{ metadata: delegating("scene"), descriptor: undefined }]);
	const [scene] = boxDelegateClients();
	installBoxes([{ metadata: delegating("scene"), descriptor: undefined }, { metadata: delegating("stage"), descriptor: undefined }]);
	expect(boxDelegateClients().map(({ box }) => box)).toEqual(["scene", "stage"]);
	expect(boxDelegateClients()[0]).toBe(scene!); // @approved The first catalog listed the Scene.
});
