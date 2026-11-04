import type { FxTurnEvent } from "libfx/node";

/** @approved The most of a tool call's input, or of its result, the panel is sent: libfx's own cut for a large input. */
export const SHOWN_BYTES = 64 * 1024;

// @approved
//  Text for the panel, cut at `SHOWN_BYTES` on a UTF-8 boundary: a character
// the cut splits is dropped, not shown broken. `truncated` says it was cut,
// here or by libfx before it.
export const shown = (text: string, truncated = false) => {
	const bytes = Buffer.from(text);
	if (bytes.byteLength <= SHOWN_BYTES) return { text, truncated };
	return { text: bytes.subarray(0, SHOWN_BYTES).toString("utf8").replace(/\uFFFD+$/, ""), truncated: true };
};

/** @approved A tool call's input as JSON text: libfx's whole input, or its preview of one too large to send whole. */
export const toolInput = (event: Extract<FxTurnEvent, { type: "tool_start" }>) =>
	event.inputTruncated === true ? shown(event.inputPreview, true) : shown(JSON.stringify(event.input ?? {}));
