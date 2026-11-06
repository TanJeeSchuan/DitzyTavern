import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { flushHook, renderTree } from "../test-fixtures/render-hook";
import { installBoxes, type BoxMetadata } from "../../shared/contract/box";
import type { Drafts } from "./ConnectionSettingsPanel";

const { BoxSettingsDrafts } = await import("./ConnectionSettingsPanel");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const clock: BoxMetadata = { id: "clock", label: "Clock", summary: "", instructions: "", decision: { summary: "", description: "", off: "", context: "" } };
const scene: BoxMetadata = { id: "scene", label: "Scene", summary: "", instructions: "", delegate: { tag: "scene", summary: "", description: "", off: "" } };

test("a Box joining the catalog while the settings are open keeps every draft already being edited", async () => {
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => Response.json(String(input).includes("delegate-settings")
		? { profileId: null, model: "", revision: 0 }
		: { decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: 4_000, revision: 0 }), { preconnect: realFetch.preconnect });
	installBoxes([{ metadata: clock, descriptor: undefined }]);
	let seen: Drafts = { decisions: [], delegates: [] };
	const view = await renderTree(() => createElement(BoxSettingsDrafts, { render: (drafts) => { seen = drafts; return null; } }), new QueryClient());
	await flushHook();
	await view.act(async () => { seen.decisions[0]?.editor.update({ decisionModel: "mine" }); });
	expect(seen.decisions[0]?.editor.dirty).toBe(true);

	installBoxes([{ metadata: clock, descriptor: undefined }, { metadata: scene, descriptor: undefined }]);
	await view.rerender();
	await flushHook();
	expect(seen.delegates.map(({ box }) => box)).toEqual(["scene"]);
	expect(seen.decisions[0]?.editor.draft?.decisionModel).toBe("mine");
	expect(seen.decisions[0]?.editor.dirty).toBe(true);
});
