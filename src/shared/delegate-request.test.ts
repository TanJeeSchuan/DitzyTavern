import { expect, test } from "bun:test";
import { delegateRequest, delegateSegments } from "./delegate-request";

test("a request is lifted from the prose around it, trimmed", () => {
	expect(delegateSegments("She waits. <scene> put the lantern on the table </scene> Then she sits.", "scene")).toEqual([
		{ kind: "prose", text: "She waits. " },
		{ kind: "request", text: "put the lantern on the table" },
		{ kind: "prose", text: " Then she sits." },
	]);
});

test("several requests in one passage join in order into one request", () => {
	expect(delegateRequest("<scene>light the lantern</scene> She turns. <scene>open the door</scene>", "scene")).toBe("light the lantern\nopen the door");
});

test("nested tags stay raw prose, whole, and run nothing", () => {
	const text = "<scene>move the <scene>lantern</scene> left</scene>";
	expect(delegateSegments(text, "scene")).toEqual([{ kind: "prose", text }]);
	expect(delegateRequest(text, "scene")).toBeUndefined();
});

test("a request after nested tags still runs", () => {
	expect(delegateRequest("<scene>a <scene>b</scene> c</scene> and <scene>open the door</scene>", "scene")).toBe("open the door");
});

test("an unclosed tag, a stray closing tag and an empty request stay raw", () => {
	expect(delegateRequest("<scene>put the lantern", "scene")).toBeUndefined();
	expect(delegateRequest("the lantern</scene> stays", "scene")).toBeUndefined();
	expect(delegateSegments("<scene>  </scene>", "scene")).toEqual([{ kind: "prose", text: "<scene>  </scene>" }]);
});

test("markup written as entities is not a tag, and an entity inside a request stays as written", () => {
	expect(delegateRequest("&lt;scene&gt;put the lantern&lt;/scene&gt;", "scene")).toBeUndefined();
	expect(delegateRequest("<scene>write &lt;/scene&gt; on the sign</scene>", "scene")).toBe("write &lt;/scene&gt; on the sign");
});

test("only the Box's own tag matches, not one that starts with it", () => {
	expect(delegateRequest("<scenery>a hill</scenery>", "scene")).toBeUndefined();
});
