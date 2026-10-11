import { Type, type Static } from "@sinclair/typebox";

export type ThoughtSegment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "thought"; readonly text: string };

// @approved
//  The body may not contain another `<thought` or `</thought`, so in nested
//  markup only the innermost pair matches and the outer tags stay raw text.
const THOUGHT = /<thought\s*>((?:(?!<\/?thought\b)[\s\S])*)<\/thought>/g;

export const stripThoughts = (text: string): ThoughtSegment[] => {
	const segments: ThoughtSegment[] = [];
	let at = 0;
	for (const match of text.matchAll(THOUGHT)) {
		const body = match[1]!.trim();
		if (body === "") continue;
		segments.push({ kind: "prose", text: text.slice(at, match.index) }, { kind: "thought", text: body });
		at = match.index + match[0].length;
	}
	segments.push({ kind: "prose", text: text.slice(at) });
	return segments.filter((segment) => segment.kind === "thought" || segment.text.trim() !== "");
};

// @approved
//  The Thoughts window read: each thought on the Selected narrative path,
//  oldest first. `key` is the Variant and the thought's place in it; `author`
//  is who wrote the passage.
export const thoughtRead = Type.Object({
	conversationId: Type.Integer(),
	revision: Type.Integer(),
	thoughts: Type.Array(Type.Object({ key: Type.String(), author: Type.Union([Type.Null(), Type.String()]), text: Type.String() })),
});
export type ThoughtRead = Static<typeof thoughtRead>;
