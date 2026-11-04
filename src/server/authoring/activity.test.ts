import { expect, test } from "bun:test";
import { SHOWN_BYTES, toolInput } from "./activity";

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
