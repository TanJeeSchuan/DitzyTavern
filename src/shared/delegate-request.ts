/** @approved A passage split around a delegating Box's tag: prose as written, and each request's text. */
export type DelegateSegment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "request"; readonly text: string };

// @approved
//  The one reading of a delegating Box's tag in prose, so the server runs
// exactly what the story view lifts. A request is `<tag>…</tag>` with no
// other `<tag>` or `</tag>` inside and some text in it. Nested tags, an
// unclosed tag and a stray closing tag stay raw prose, the nested ones whole,
// so a request the writer did not finish writing never runs. Markup written
// as entities, `&lt;tag&gt;`, is not a tag. The tag is a descriptor's, which
// its pattern keeps free of regular expression syntax.
export const delegateSegments = (text: string, tag: string): DelegateSegment[] => {
	const tokens = [...text.matchAll(new RegExp(`<(/?)${tag}>`, "g"))].map((match) => ({ close: match[1] === "/", start: match.index, end: match.index + match[0].length }));
	const segments: DelegateSegment[] = [];
	let prose = 0;
	for (let index = 0; index < tokens.length;) {
		const open = tokens[index]!; // @approved The loop bound keeps the index inside.
		const next = tokens[index + 1];
		if (open.close || next === undefined) { index += 1; continue; }
		if (next.close) {
			const body = text.slice(open.end, next.start).trim();
			if (body !== "") {
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
export const delegateRequest = (text: string, tag: string): string | undefined => {
	const requests = delegateSegments(text, tag).flatMap((segment) => segment.kind === "request" ? [segment.text] : []);
	return requests.length === 0 ? undefined : requests.join("\n");
};
