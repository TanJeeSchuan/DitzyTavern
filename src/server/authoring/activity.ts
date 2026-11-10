import type { FxTurnEvent } from "libfx/node";

/** @approved The most of a tool call's input, or of its result, the panel is sent: libfx's own cut for a large input. */
export const SHOWN_BYTES = 64 * 1024;

// @approved
//  Text for the panel, cut at `cap` bytes, `SHOWN_BYTES` unless given, on a
// UTF-8 boundary: a character the cut splits is dropped, not shown broken.
// `truncated` says it was cut, here or by libfx before it.
export const shown = (text: string, truncated = false, cap = SHOWN_BYTES) => {
	const bytes = Buffer.from(text);
	if (bytes.byteLength <= cap) return { text, truncated };
	return { text: bytes.subarray(0, cap).toString("utf8").replace(/\uFFFD+$/, ""), truncated: true };
};

// @approved
//  One reasoning entry's deltas, held to `SHOWN_BYTES` in all: each delta is
// forwarded while the entry has room, the one that reaches the cap is cut
// and marked `truncated`, and nothing more is forwarded until `reset` starts
// the next entry, when a tool call starts or ends, as the panel's entries do.
export const reasoningEntry = () => {
	let bytes = 0;
	let cut = false;
	return {
		next: (delta: string) => {
			if (cut) return undefined;
			const part = shown(delta, false, SHOWN_BYTES - bytes);
			bytes += Buffer.byteLength(part.text);
			cut = part.truncated;
			return part;
		},
		reset: () => {
			bytes = 0;
			cut = false;
		},
	};
};

/** @approved A tool call's input as JSON text: libfx's whole input, or its preview of one too large to send whole. */
export const toolInput = (event: Extract<FxTurnEvent, { type: "tool_start" }>) =>
	event.inputTruncated === true ? shown(event.inputPreview, true) : shown(JSON.stringify(event.input ?? {}));
