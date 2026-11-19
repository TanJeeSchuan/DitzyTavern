export type ThoughtSegment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "thought"; readonly text: string };

// @approved
//  The body may not contain another `<thought` or `</thought`, so in nested
//  markup only the innermost pair matches and the outer tags stay raw text.
const THOUGHT = /<thought\s*>((?:(?!<\/?thought\b)[\s\S])*)<\/thought>/g;

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
