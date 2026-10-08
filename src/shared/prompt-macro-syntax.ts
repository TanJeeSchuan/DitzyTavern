// @approved
//  The macro language has one lexical owner. The importer and evaluator
// both consume this scanner so delimiter balancing, escaping, and Prompt Comment boundaries
// cannot drift between the two paths.

export interface MacroContext {
	self: string;
	other: string;
}

export type MacroToken =
	| { kind: "backslash-pair"; end: number }
	| { kind: "escaped-macro"; name: string; end: number }
	| { kind: "escaped-comment"; end: number }
	| { kind: "comment"; end: number }
	| { kind: "macro"; name: string; end: number }
	| { kind: "char"; end: number };

export const isEscaped = (source: string, index: number): boolean => {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
	return slashes % 2 === 1;
};

interface MacroScanIndex {
	readonly macroEnds: ReadonlyMap<number, number>;
	readonly escapedOpeners: ReadonlySet<number>;
	readonly scopedCommentEnds: ReadonlyMap<number, number>;
}

const buildMacroScanIndex = (source: string): MacroScanIndex => {
	const macroEnds = new Map<number, number>();
	const escapedOpeners = new Set<number>();
	const scopedCommentEnds = new Map<number, number>();
	const openStack: number[] = [];
	const scopedCommentOpeners: number[] = [];
	let slashRun = 0;

	for (let index = 0; index < source.length; index += 1) {
		const escaped = slashRun % 2 === 1;
		if (source.startsWith("{{", index)) {
			if (source.startsWith("{{//}}", index)) scopedCommentOpeners.push(index);
			if (escaped) escapedOpeners.add(index);
			openStack.push(index);
		}
		if (source.startsWith("{{///}}", index) && !escaped) {
			for (const opener of scopedCommentOpeners) {
				scopedCommentEnds.set(opener, index + "{{///}}".length);
			}
			scopedCommentOpeners.length = 0;
		}
		if (source.startsWith("}}", index) && !escaped) {
			const opener = openStack.pop();
			if (opener !== undefined) macroEnds.set(opener, index + 2);
			index += 1;
			slashRun = 0;
			continue;
		}
		if (source.startsWith("{{", index)) {
			index += 1;
			slashRun = 0;
			continue;
		}
		if (source[index] === "\\") slashRun += 1;
		else slashRun = 0;
	}
	return { macroEnds, escapedOpeners, scopedCommentEnds };
};

let cachedMacroScan: { source: string; index: MacroScanIndex } | undefined;

const macroScanIndex = (source: string): MacroScanIndex => {
	if (cachedMacroScan?.source === source) return cachedMacroScan.index;
	const index = buildMacroScanIndex(source);
	cachedMacroScan = { source, index };
	return index;
};

const macroEnd = (source: string, start: number, allowEscapedStart = false): number | null => {
	if (!source.startsWith("{{", start)) return null;
	const index = macroScanIndex(source);
	if (!allowEscapedStart && index.escapedOpeners.has(start)) return null;
	return index.macroEnds.get(start) ?? null;
};

// @approved
//  Prompt Comment recognition includes both supported forms. The scoped
// close scan is deliberately here rather than in either consumer.
export const promptCommentEnd = (source: string, start: number): number | null => {
	if (!source.startsWith("{{//", start)) return null;
	if (source.startsWith("{{//}}", start)) {
		return macroScanIndex(source).scopedCommentEnds.get(start) ?? null;
	}
	return macroEnd(source, start, true);
};

interface MacroMatch {
	name: string;
	end: number;
}

const matchMacro = (source: string, start: number): MacroMatch | null => {
	const end = macroEnd(source, start, true);
	return end === null ? null : { name: source.slice(start + 2, end - 2), end };
};

export const scanMacroToken = (
	source: string,
	index: number,
	recognizes: (name: string) => boolean,
): MacroToken => {
	if (source[index] === "\\") {
		if (source[index + 1] === "\\") return { kind: "backslash-pair", end: index + 2 };
		const escapedCommentEnd = promptCommentEnd(source, index + 1);
		if (escapedCommentEnd !== null) return { kind: "escaped-comment", end: escapedCommentEnd };
		const escaped = matchMacro(source, index + 1);
		if (escaped !== null && recognizes(escaped.name)) {
			return { kind: "escaped-macro", name: escaped.name, end: escaped.end };
		}
		return { kind: "char", end: index + 1 };
	}
	if (source[index] !== "{") return { kind: "char", end: index + 1 };
	const commentEnd = promptCommentEnd(source, index);
	if (commentEnd !== null) return { kind: "comment", end: commentEnd };
	const macro = matchMacro(source, index);
	if (macro !== null) return { kind: "macro", name: macro.name, end: macro.end };
	return { kind: "char", end: index + 1 };
};

// @approved
//  Used after parsing classifies a segment as literal. Split-brace escapes
// lose their marker; complete escaped macros/comments and backslash pairs stay verbatim.
export const unescapeMacroText = (source: string): string => {
	let output = "";
	let index = 0;
	while (index < source.length) {
		const token = scanMacroToken(source, index, () => true);
		const splitBraceEscape = token.kind === "char" && source[index] === "\\" &&
			(source[index + 1] === "{" || source[index + 1] === "}") &&
			source.slice(index + 1, index + 3) !== "{{" && source.slice(index + 1, index + 3) !== "}}";
		output += splitBraceEscape ? source.slice(index + 1, token.end) : source.slice(index, token.end);
		index = token.end;
	}
	return output;
};

export interface TextNode {
	readonly kind: "text";
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

export interface MacroArgument {
	readonly nodes: readonly MacroDocumentNode[];
	readonly raw: string;
	readonly start: number;
	readonly end: number;
}

export interface MacroNode {
	readonly kind: "macro";
	readonly name: string;
	readonly flags: readonly string[];
	readonly args: readonly MacroArgument[];
	readonly scope: readonly MacroDocumentNode[] | undefined;
	readonly raw: string;
	readonly start: number;
	readonly end: number;
}

export type MacroDocumentNode = TextNode | MacroNode;

const headerNamePattern = /^([A-Za-z](?:[\w-]*[\w])?|[.$][A-Za-z](?:[\w-]*[\w])?|\/\/|\/\/\/)(.*)$/s;
const bareHeaderPattern = /^[.$]?[A-Za-z](?:[\w-]*[\w])?$/;

interface ParsedHeader {
	readonly name: string;
	readonly flags: string[];
	readonly argument: { start: number; end: number } | undefined;
}

const trimmedRange = (source: string, start: number, end: number) => {
	while (start < end && /\s/.test(source[start] ?? "")) start += 1;
	while (end > start && /\s/.test(source[end - 1] ?? "")) end -= 1;
	return { start, end };
};

const parseHeader = (source: string, start: number, end: number): ParsedHeader | undefined => {
	const trimmed = trimmedRange(source, start, end);
	let cursor = trimmed.start;
	const text = source.slice(cursor, trimmed.end);
	if (text === "//" || text === "///") return { name: text, flags: [], argument: undefined };
	if (text.startsWith("//")) {
		const argument = trimmedRange(source, cursor + 2, trimmed.end);
		return {
			name: "//",
			flags: [],
			argument: argument.start === argument.end ? undefined : argument,
		};
	}
	const flags: string[] = [];
	while (cursor < trimmed.end && "#!/".includes(source[cursor] ?? "")) {
		flags.push(source[cursor] ?? "");
		cursor += 1;
		while (cursor < trimmed.end && /\s/.test(source[cursor] ?? "")) cursor += 1;
	}
	const match = source.slice(cursor, trimmed.end).match(headerNamePattern);
	if (match === null || match[1] === undefined) return undefined;
	const name = match[1];
	const tail = match[2] ?? "";
	const argument = trimmedRange(source, cursor + name.length, cursor + name.length + tail.length);
	return {
		name,
		flags,
		argument: name === "///" || argument.start === argument.end ? undefined : argument,
	};
};

interface ArgumentSeparator {
	readonly start: number;
	readonly length: 1 | 2;
}

const argumentSeparators = (
	source: string,
	start: number,
	end: number,
): readonly ArgumentSeparator[] => {
	const doubles: ArgumentSeparator[] = [];
	for (let cursor = start; cursor < end;) {
		const token = scanMacroToken(source, cursor, () => true);
		if (token.kind === "escaped-comment" || token.kind === "backslash-pair") {
			cursor = Math.min(token.end, end);
			continue;
		}
		const nestedEnd = macroEnd(source, cursor, true);
		if (nestedEnd !== null && nestedEnd <= end) {
			cursor = nestedEnd;
			continue;
		}
		if (source.startsWith("::", cursor)) {
			doubles.push({ start: cursor, length: 2 });
			cursor += 2;
			continue;
		}
		if (
			doubles.length === 0 &&
			source[cursor] === ":" &&
			bareHeaderPattern.test(source.slice(start, cursor).trim().replace(/^[#!/]+\s*/, ""))
		) return [{ start: cursor, length: 1 }];
		cursor += 1;
	}
	return doubles;
};

const textNode = (source: string, start: number, end: number): TextNode => ({
	kind: "text",
	text: source.slice(start, end),
	start,
	end,
});

const attachScopes = (nodes: readonly MacroDocumentNode[], source: string): MacroDocumentNode[] => {
	const pairs = new Map<number, number>();
	const openStacks = new Map<string, number[]>();
	for (const [index, node] of nodes.entries()) {
		if (node.kind === "text") continue;
		const name = node.name.toLowerCase();
		if (name === "///" && !isEscaped(source, node.start)) {
			const opener = openStacks.get("//")?.pop();
			if (opener !== undefined) pairs.set(opener, index);
			continue;
		}
		if (node.flags.includes("/")) {
			if (isEscaped(source, node.start)) continue;
			const opener = openStacks.get(name)?.pop();
			if (opener !== undefined) pairs.set(opener, index);
			continue;
		}
		if (isEscaped(source, node.start)) continue;
		if (name === "//" && node.args.length > 0) continue;
		const stack = openStacks.get(name) ?? [];
		stack.push(index);
		openStacks.set(name, stack);
	}

	const build = (start: number, end: number): MacroDocumentNode[] => {
		const result: MacroDocumentNode[] = [];
		for (let index = start; index < end; index += 1) {
			const node = nodes[index];
			if (node === undefined) continue;
			if (node.kind === "text") {
				result.push(node);
				continue;
			}
			if (node.name === "///" || node.flags.includes("/")) {
				result.push(textNode(source, node.start, node.end));
				continue;
			}
			const closeIndex = pairs.get(index);
			if (closeIndex === undefined) {
				result.push(node);
				continue;
			}
			const close = nodes[closeIndex];
			if (close === undefined || close.kind === "text") {
				result.push(node);
				continue;
			}
			result.push({
				...node,
				scope: build(index + 1, closeIndex),
				raw: source.slice(node.start, close.end),
				end: close.end,
			});
			index = closeIndex;
		}
		return result;
	};
	return build(0, nodes.length);
};

const macroArgument = (source: string, start: number, end: number): MacroArgument => ({
	nodes: parseNodes(source, start, end),
	raw: source.slice(start, end),
	start,
	end,
});

const parseMacro = (source: string, start: number, end: number): MacroDocumentNode => {
	const bodyStart = start + 2;
	const bodyEnd = end - 2;
	const separators = argumentSeparators(source, bodyStart, bodyEnd);
	const header = parseHeader(source, bodyStart, separators[0]?.start ?? bodyEnd);
	if (header === undefined) return textNode(source, start, end);
	const args: MacroArgument[] = [];
	if (header.argument !== undefined) {
		args.push(macroArgument(source, header.argument.start, header.argument.end));
	}
	for (const [index, separator] of separators.entries()) {
		const argumentStart = separator.start + separator.length;
		args.push(macroArgument(source, argumentStart, separators[index + 1]?.start ?? bodyEnd));
	}
	return {
		kind: "macro",
		name: header.name,
		flags: header.flags,
		args,
		scope: undefined,
		raw: source.slice(start, end),
		start,
		end,
	};
};

function parseNodes(source: string, start: number, end: number): MacroDocumentNode[] {
	const nodes: MacroDocumentNode[] = [];
	let textStart = start;
	const pushText = (textEnd: number) => {
		if (textStart < textEnd) nodes.push(textNode(source, textStart, textEnd));
	};
	for (let cursor = start; cursor < end;) {
		const token = scanMacroToken(source, cursor, () => true);
		if (token.kind === "escaped-comment" || token.kind === "backslash-pair") {
			cursor = Math.min(token.end, end);
			continue;
		}
		const nestedEnd = macroEnd(source, cursor, true);
		if (nestedEnd === null || nestedEnd > end) {
			cursor += 1;
			continue;
		}
		pushText(cursor);
		nodes.push(parseMacro(source, cursor, nestedEnd));
		cursor = nestedEnd;
		textStart = cursor;
	}
	pushText(end);
	return attachScopes(nodes, source);
}

export const sliceMacroDocument = (
	nodes: readonly MacroDocumentNode[],
	start: number,
	end: number,
	source: string,
): MacroDocumentNode[] => {
	const sliced: MacroDocumentNode[] = [];
	for (const node of nodes) {
		if (node.end <= start || node.start >= end) continue;
		if (node.kind === "macro" && node.start >= start && node.end <= end) {
			sliced.push(node);
			continue;
		}
		const textStart = Math.max(start, node.start);
		const textEnd = Math.min(end, node.end);
		if (textStart < textEnd) sliced.push(textNode(source, textStart, textEnd));
	}
	return sliced;
};

export const parseMacroDocument = (source: string): MacroDocumentNode[] =>
	parseNodes(source, 0, source.length);
