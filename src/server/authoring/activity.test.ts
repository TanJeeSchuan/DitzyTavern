import { expect, test } from "bun:test";
import { reasoningEntry, SHOWN_BYTES, toolInput } from "./activity";

test("a tool call's input reaches the panel whole when it fits, and cut at the cap on a character boundary when it does not", () => {
	expect(toolInput({ type: "tool_start", id: "a", name: "write_css", input: { content: "p {}" } })).toEqual({ text: '{"content":"p {}"}', truncated: false });
	const { text, truncated } = toolInput({ type: "tool_start", id: "b", name: "write_logic", input: { content: "é".repeat(SHOWN_BYTES) } });
	expect(truncated).toBe(true);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SHOWN_BYTES);
	expect(Buffer.byteLength(text)).toBeGreaterThan(SHOWN_BYTES - 4);
	expect(text).toStartWith('{"content":"éé');
	expect(text).not.toContain("�");
});

test("libfx's preview of an input too large to stream stays marked as cut, however short it is", () => {
	expect(toolInput({ type: "tool_start", id: "c", name: "write_ui", inputTruncated: true, inputPreview: '{"content":"host.' })).toEqual({ text: '{"content":"host.', truncated: true });
});

test("one reasoning entry forwards at most the cap in all, marks the delta that reaches it, then forwards nothing until the next entry", () => {
	const entry = reasoningEntry();
	const parts = Array.from({ length: 80 }, () => entry.next("é".repeat(512)));
	const forwarded = parts.flatMap((part) => part === undefined ? [] : [part]);
	expect(forwarded.reduce((bytes, { text }) => bytes + Buffer.byteLength(text), 0)).toBe(SHOWN_BYTES);
	expect(forwarded.map(({ truncated }) => truncated)).toEqual([...Array(64).fill(false), true]);
	expect(forwarded.at(-1)?.text).toBe("");
	expect(parts.slice(65)).toEqual(Array(15).fill(undefined));
	entry.reset();
	expect(entry.next("Next step.")).toEqual({ text: "Next step.", truncated: false });
});
