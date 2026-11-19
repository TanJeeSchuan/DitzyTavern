type ThoughtSegment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "thought"; readonly text: string };

const openThought = /<thought\s*>/.source;
const closeThought = /<\/thought>/.source;

// @approved
//  The body may not contain another `<thought` or `</thought`, so in nested
//  markup only the innermost pair matches and the outer tags stay raw text.
const THOUGHT = new RegExp(String.raw`${openThought}((?:(?!<\/?thought\b)[\s\S])*)${closeThought}`, "g");

export const stripThoughts = (text: string): ThoughtSegment[] => {
	const segments: ThoughtSegment[] = [];
	let at = 0;
	for (const match of text.matchAll(THOUGHT)) {
		/** @approved THOUGHT always captures its body group. */
		const body = match[1]!.trim();
		if (body === "") continue;
		segments.push({ kind: "prose", text: text.slice(at, match.index) }, { kind: "thought", text: body });
		at = match.index + match[0].length;
	}
	segments.push({ kind: "prose", text: text.slice(at) });
	return segments.filter((segment) => segment.kind === "thought" || segment.text.trim() !== "");
};

const THOUGHT_TAG = new RegExp(`(${openThought})|${closeThought}`, "g");

/** @approved Continuous prose outside every closed thought, including nested markup. */
export const proseOutsideThoughts = (text: string): string[] => {
	const openings: { start: number; spanCount: number }[] = [];
	const spans: { start: number; end: number }[] = [];
	for (const match of text.matchAll(THOUGHT_TAG)) {
		if (match[1] !== undefined) {
			openings.push({ start: match.index, spanCount: spans.length });
			continue;
		}
		const opened = openings.pop();
		if (opened === undefined) continue;
		spans.length = opened.spanCount;
		spans.push({ start: opened.start, end: match.index + match[0].length });
	}
	let at = 0;
	const prose = spans.map(({ start, end }) => {
		const segment = text.slice(at, start);
		at = end;
		return segment;
	});
	return [...prose, text.slice(at)];
};
