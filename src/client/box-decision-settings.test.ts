import { expect, test } from "bun:test";
import { installBoxes, type BoxMetadata } from "../shared/contract/box";
import { boxDelegateClients } from "./box-decision-settings";

const delegating = (id: string, label = id): BoxMetadata => ({ id, label, summary: "", instructions: "", delegate: { tag: id, summary: `${label} summary`, description: "", off: "Off" } });

test("a delegating Box installed while the app runs joins the delegate settings, and a listed one keeps its load and save but shows its new copy", () => {
	installBoxes([{ metadata: delegating("scene", "Old"), descriptor: undefined }]);
	const [scene] = boxDelegateClients();
	installBoxes([{ metadata: delegating("scene", "New"), descriptor: undefined }, { metadata: delegating("stage"), descriptor: undefined }]);
	expect(boxDelegateClients().map(({ box, label, delegate }) => [box, label, delegate.summary])).toEqual([["scene", "New", "New summary"], ["stage", "stage", "stage summary"]]);
	expect(boxDelegateClients()[0]?.load).toBe(scene!.load); // @approved The first catalog listed the Scene.
});
