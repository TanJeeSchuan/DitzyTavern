/** @approved A passage split around a delegating Box's tag: prose as written, and each request's text. */
export type DelegateSegment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "request"; readonly text: string };

type Span = { readonly start: number; readonly end: number };

// @approved
//  Each element of another Box's tag in the passage, its open paired with the
// innermost close after it of the same name; an open with no close encloses
// nothing. A lens may carry attributes, as `<sms from="…">` does.
const otherElements = (text: string, others: readonly string[]): Span[] => others.flatMap((tag) => {
	const opens: number[] = [];
	const spans: Span[] = [];
	for (const match of text.matchAll(new RegExp(`<(/?)${tag}(?:\\s[^<>]*)?>`, "g"))) {
		if (match[1] !== "/") opens.push(match.index);
		const open = match[1] === "/" ? opens.pop() : undefined;
		if (open !== undefined) spans.push({ start: open, end: match.index + match[0].length });
	}
	return spans;
});

// @approved
//  The one reading of a delegating Box's tag in prose, so the server runs
// exactly what the story view lifts. A request is `<tag>…</tag>` with no
// other `<tag>` or `</tag>` inside and some text in it. Nested tags, an
// unclosed tag and a stray closing tag stay raw prose, the nested ones whole,
// so a request the writer did not finish writing never runs. Nesting counts
// across Boxes: a request inside another Box's element (`others`, every
// other lens and delegate tag), or holding one, stays raw, since the lens
// that lifts the outer element would hide it. Markup written as entities,
// `&lt;tag&gt;`, is not a tag. A tag is a descriptor's, whose pattern keeps
// it free of regular expression syntax.
export const delegateSegments = (text: string, tag: string, others: readonly string[]): DelegateSegment[] => {
	const tokens = [...text.matchAll(new RegExp(`<(/?)${tag}>`, "g"))].map((match) => ({ close: match[1] === "/", start: match.index, end: match.index + match[0].length }));
	const elements = otherElements(text, others);
	const crosses = ({ start, end }: Span) => elements.some((element) => (element.start < start && start < element.end) || (start < element.start && element.start < end));
	const segments: DelegateSegment[] = [];
	let prose = 0;
	for (let index = 0; index < tokens.length;) {
		const open = tokens[index]!; // @approved The loop bound keeps the index inside.
		const next = tokens[index + 1];
		if (open.close || next === undefined) { index += 1; continue; }
		if (next.close) {
			const body = text.slice(open.end, next.start).trim();
			if (body !== "" && !crosses({ start: open.start, end: next.end })) {
				segments.push({ kind: "prose", text: text.slice(prose, open.start) }, { kind: "request", text: body });
				prose = next.end;
			}
			index += 2;
			continue;
		}
		let depth = 0;
		do {
			depth += tokens[index]!.close ? -1 : 1; // @approved The loop condition keeps the index inside.
			index += 1;
		} while (depth > 0 && index < tokens.length);
	}
	segments.push({ kind: "prose", text: text.slice(prose) });
	return segments.filter((segment) => segment.kind === "request" || segment.text !== "");
};

/** @approved The passage's requests joined in order into one, or undefined when it holds none. */
export const delegateRequest = (text: string, tag: string, others: readonly string[]): string | undefined => {
	const requests = delegateSegments(text, tag, others).flatMap((segment) => segment.kind === "request" ? [segment.text] : []);
	return requests.length === 0 ? undefined : requests.join("\n");
};
