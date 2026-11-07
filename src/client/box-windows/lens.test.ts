import { describe, expect, test } from "bun:test";
import type { ConversationSummary } from "../conversation";
import { installBoxes } from "../../shared/contract/box";
import { createBoxLens, delegateLens } from "./lens";

type Segment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "aside"; readonly text: string };

const ASIDE = /<aside>([^<]*)<\/aside>/g;
const strip = (text: string): Segment[] => {
	const segments: Segment[] = [];
	let at = 0;
	for (const match of text.matchAll(ASIDE)) {
		segments.push({ kind: "prose", text: text.slice(at, match.index) }, { kind: "aside", text: match[1]! });
		at = match.index + match[0].length;
	}
	segments.push({ kind: "prose", text: text.slice(at) });
	return segments;
};

const lens = createBoxLens("aside", () => ({}), strip, (run) => run.join(" + "));
// SAFETY: the gate ignores the Chat it is given, and only the returned `lift` runs.
const conversation = {} as ConversationSummary;
const lift = (text: string) => lens.gate(conversation)!(text);

describe("createBoxLens", () => {
	test("a run is every lifted segment in a row, separated by whitespace alone, which it drops", () => {
		expect(lift("<aside>a</aside> \n<aside>b</aside> tail")).toEqual([
			{ kind: "lifted", line: "a + b" },
			{ kind: "prose", text: " tail" },
		]);
	});

	test("any other prose splits runs", () => {
		expect(lift("<aside>a</aside> and <aside>b</aside>")).toEqual([
			{ kind: "lifted", line: "a" },
			{ kind: "prose", text: " and " },
			{ kind: "lifted", line: "b" },
		]);
	});
});

describe("delegateLens", () => {
	test("it lifts exactly the requests the server runs, leaving one nested in another Box's markup raw", () => {
		installBoxes([
			{ metadata: { id: "thought", label: "Thoughts", summary: "", instructions: "", lens: "thought" }, descriptor: undefined },
			{ metadata: { id: "scene", label: "Scene", summary: "", instructions: "", delegate: { tag: "scene", summary: "", description: "", off: "" } }, descriptor: undefined },
		]);
		const nested = " She waits. <thought><scene>open the door</scene></thought>";
		expect(delegateLens("scene").gate(conversation)!(`<scene>light the lantern</scene>${nested}`)).toEqual([
			{ kind: "lifted", line: "light the lantern" },
			{ kind: "prose", text: nested },
		]);
	});
});
