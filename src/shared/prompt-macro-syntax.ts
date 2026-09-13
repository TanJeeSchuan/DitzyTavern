import {
	CstParser,
	Lexer,
	createToken,
	type CstNode,
	type IToken,
} from "chevrotain";

// ==[HUMAN APPROVED]== The macro language has one lexical owner. The importer and evaluator
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

const macroEnd = (source: string, start: number, allowEscapedStart = false): number | null => {
	if (!source.startsWith("{{", start)) return null;
	let depth = 0;
	for (let index = start; index < source.length - 1; index += 1) {
		if (source.startsWith("{{", index) && ((index === start && allowEscapedStart) || !isEscaped(source, index))) {
			depth += 1;
			index += 1;
			continue;
		}
		if (source.startsWith("}}", index) && !isEscaped(source, index)) {
			depth -= 1;
			if (depth === 0) return index + 2;
			index += 1;
		}
	}
	return null;
};

const balancedMacroAt = (source: string, start: number, allowEscapedStart = false): boolean =>
	macroEnd(source, start, allowEscapedStart) !== null;

// ==[HUMAN APPROVED]== Prompt Comment recognition includes both supported forms. The scoped
// close scan is deliberately here rather than in either consumer.
export const promptCommentEnd = (source: string, start: number): number | null => {
	if (!source.startsWith("{{//", start)) return null;
	if (source.startsWith("{{//}}", start)) {
		for (let index = start + "{{//}}".length; index <= source.length - "{{///}}".length; index += 1) {
			if (source.startsWith("{{///}}", index) && !isEscaped(source, index)) {
				return index + "{{///}}".length;
			}
		}
		return null;
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

// ==[HUMAN APPROVED]== Used after parsing classifies a segment as literal. Split-brace escapes
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

const openPattern = (source: string, offset: number): [string] | null =>
	balancedMacroAt(source, offset, true) ? ["{{"] : null;

const closePattern = (source: string, offset: number): [string] | null =>
	source.startsWith("}}", offset) && !isEscaped(source, offset) ? ["}}"] : null;

const bareMacroHeader = (source: string, offset: number): string => {
	const open = source.lastIndexOf("{{", offset);
	return open < 0 ? "" : source.slice(open + 2, offset).trim().replace(/^[#!/]+\s*/, "");
};

const singleColonPattern = (source: string, offset: number): [string] | null => {
	if (source[offset] !== ":" || source[offset + 1] === ":") return null;
	return /^[.$]?[A-Za-z](?:[\w-]*[\w])?$/.test(bareMacroHeader(source, offset)) ? [":"] : null;
};

const documentTextPattern = (source: string, offset: number): [string] | null => {
	let end = offset;
	while (end < source.length) {
		const token = scanMacroToken(source, end, () => true);
		if (token.kind === "macro" || token.kind === "comment") break;
		if (token.kind === "escaped-comment" || token.kind === "backslash-pair") {
			end = token.end;
			continue;
		}
		end += 1;
	}
	return end === offset ? null : [source.slice(offset, end)];
};

const macroPartPattern = (source: string, offset: number): [string] | null => {
	let end = offset;
	while (end < source.length) {
		const token = scanMacroToken(source, end, () => true);
		if (token.kind === "macro" || token.kind === "comment" || closePattern(source, end) !== null || source.startsWith("::", end) || singleColonPattern(source, end) !== null) break;
		if (token.kind === "escaped-comment" || token.kind === "backslash-pair") {
			end = token.end;
			continue;
		}
		end += 1;
	}
	return end === offset ? null : [source.slice(offset, end)];
};

const MacroOpen = createToken({ name: "MacroOpen", pattern: { exec: openPattern }, push_mode: "macro", line_breaks: false });
const MacroClose = createToken({ name: "MacroClose", pattern: { exec: closePattern }, pop_mode: true, line_breaks: false });
const DoubleColon = createToken({ name: "DoubleColon", pattern: /::/ });
const Colon = createToken({ name: "Colon", pattern: { exec: singleColonPattern }, line_breaks: false });
const DocumentText = createToken({ name: "DocumentText", pattern: { exec: documentTextPattern }, line_breaks: true });
const MacroPart = createToken({ name: "MacroPart", pattern: { exec: macroPartPattern }, line_breaks: true });

const macroLexer = new Lexer({
	modes: {
		document: [MacroOpen, DocumentText],
		macro: [MacroOpen, MacroClose, DoubleColon, Colon, MacroPart],
	},
	defaultMode: "document",
}, { ensureOptimizations: false });

class MacroDocumentParser extends CstParser {
	public macro = this.RULE("macro", () => {
		this.CONSUME(MacroOpen);
		this.SUBRULE(this.macroHead);
		this.OPTION1(() => this.OR([
			{ ALT: () => this.SUBRULE(this.doubleColonArguments) },
			{ ALT: () => this.SUBRULE(this.singleColonArguments) },
		]));
		this.CONSUME(MacroClose);
	});

	public macroHead = this.RULE("macroHead", () => {
		this.MANY(() => this.OR([
			{ ALT: () => this.CONSUME(MacroPart) },
			{ ALT: () => this.SUBRULE(this.macro) },
		]));
	});

	public macroArgument = this.RULE("macroArgument", () => {
		this.MANY(() => this.OR([
			{ ALT: () => this.CONSUME(MacroPart) },
			{ ALT: () => this.CONSUME(Colon) },
			{ ALT: () => this.SUBRULE(this.macro) },
		]));
	});

	public doubleColonArguments = this.RULE("doubleColonArguments", () => {
		this.AT_LEAST_ONE(() => {
			this.CONSUME(DoubleColon);
			this.SUBRULE(this.macroArgument);
		});
	});

	public singleColonArguments = this.RULE("singleColonArguments", () => {
		this.CONSUME(Colon);
		this.SUBRULE(this.macroArgument);
	});

	public documentPart = this.RULE("documentPart", () => this.OR([
		{ ALT: () => this.CONSUME(DocumentText) },
		{ ALT: () => this.SUBRULE(this.macro) },
	]));

	public document = this.RULE("document", () => {
		this.MANY(() => this.SUBRULE(this.documentPart));
	});

	constructor() {
		super([MacroOpen, MacroClose, DoubleColon, Colon, DocumentText, MacroPart], {
			recoveryEnabled: true,
			nodeLocationTracking: "full",
		});
		this.performSelfAnalysis();
	}
}

const documentParser = new MacroDocumentParser();

const tokenFrom = (children: CstNode["children"], name: string): IToken | undefined => {
	const value = children[name]?.[0];
	return value !== undefined && "image" in value ? value : undefined;
};

const nodeFrom = (children: CstNode["children"], name: string): CstNode | undefined => {
	const value = children[name]?.[0];
	return value !== undefined && "children" in value ? value : undefined;
};

const cstNode = (value: CstNode | IToken): CstNode => {
	if ("children" in value) return value;
	throw new Error("Macro parser produced a token where a CST node was required.");
};

const orderedElements = (elements: readonly (CstNode | IToken)[]): (CstNode | IToken)[] => [...elements].sort((left, right) =>
	("image" in left ? left.startOffset ?? 0 : left.location?.startOffset ?? 0) -
	("image" in right ? right.startOffset ?? 0 : right.location?.startOffset ?? 0));

const nodeText = (node: MacroDocumentNode): string => node.kind === "text" ? node.text : node.raw;

interface MacroSequence {
	readonly nodes: MacroDocumentNode[];
	readonly start: number;
	readonly end: number;
	readonly raw: string;
}

const sequenceRaw = (nodes: readonly MacroDocumentNode[]): string => nodes.map(nodeText).join("");

const nodeStart = (node: MacroDocumentNode): number => node.start;
const nodeEnd = (node: MacroDocumentNode): number => node.end;

const sequenceSlice = (
	nodes: readonly MacroDocumentNode[],
	start: number,
	end: number,
	source: string,
): MacroSequence => {
	const sliced: MacroDocumentNode[] = [];
	for (const node of nodes) {
		if (nodeEnd(node) <= start || nodeStart(node) >= end) continue;
		if (node.kind === "macro" && nodeStart(node) >= start && nodeEnd(node) <= end) {
			sliced.push(node);
			continue;
		}
		const textStart = Math.max(start, nodeStart(node));
		const textEnd = Math.min(end, nodeEnd(node));
		if (textStart < textEnd) sliced.push({
			kind: "text",
			text: source.slice(textStart, textEnd),
			start: textStart,
			end: textEnd,
		});
	}
	return { nodes: sliced, start, end, raw: source.slice(start, end) };
};

export const sliceMacroDocument = (
	nodes: readonly MacroDocumentNode[],
	start: number,
	end: number,
	source: string,
): MacroDocumentNode[] => sequenceSlice(nodes, start, end, source).nodes;

interface ParsedHeader {
	name: string;
	flags: string[];
	args: string[];
	argumentStart: number | undefined;
}

const parseHeader = (body: string): ParsedHeader | undefined => {
	let text = body.trim();
	const textStart = body.indexOf(text);
	const flags: string[] = [];
	if (text === "//" || text === "///") return { name: text, flags, args: [], argumentStart: undefined };
	if (text.startsWith("//")) {
		const tail = text.slice(2).trim();
		return {
			name: "//",
			flags,
			args: tail === "" ? [] : [tail],
			argumentStart: tail === "" ? undefined : textStart + text.indexOf(tail, 2),
		};
	}
	while (text.length > 0 && "#!/".includes(text[0] ?? "")) {
		flags.push(text[0] ?? "");
		text = text.slice(1).trimStart();
	}
	const nameMatch = text.match(/^([A-Za-z](?:[\w-]*[\w])?|[.$][A-Za-z](?:[\w-]*[\w])?|\/\/|\/\/\/)(.*)$/s);
	if (nameMatch === null) return undefined;
	const name = nameMatch[1];
	const tail = nameMatch[2].trim();
	if (name === "///" || tail === "") return { name, flags, args: [], argumentStart: undefined };
	const nameOffset = body.indexOf(name, Math.max(0, textStart));
	const tailOffset = nameOffset < 0 ? undefined : nameOffset + name.length + nameMatch[2].indexOf(tail);
	return { name, flags, args: [tail], argumentStart: tailOffset };
};

class MacroAstVisitor extends documentParser.getBaseCstVisitorConstructorWithDefaults() {
	constructor() {
		super();
		this.validateVisitor();
	}

	private visitNode(node: CstNode, source: string): MacroDocumentNode {
		// ==[HUMAN APPROVED]== SAFETY: Every visitor rule returns a MacroDocumentNode by construction.
		return this.visit(node, source) as MacroDocumentNode;
	}

	private visitSequence(node: CstNode, source: string): MacroSequence {
		// ==[HUMAN APPROVED]== SAFETY: macroHead and macroArgument visitor rules both return the
		// sequence shape declared above; Chevrotain invokes them with the same source.
		return this.visit(node, source) as MacroSequence;
	}

	public document(ctx: CstNode["children"], source: string): MacroDocumentNode[] {
		return (ctx.documentPart ?? []).map((part) => this.visitNode(cstNode(part), source));
	}

	public documentPart(ctx: CstNode["children"], source: string): MacroDocumentNode {
		const text = tokenFrom(ctx, "DocumentText");
		if (text !== undefined) {
			const start = text.startOffset ?? 0;
			return { kind: "text", text: text.image, start, end: start + text.image.length };
		}
		const macro = nodeFrom(ctx, "macro");
		return macro === undefined ? { kind: "text", text: "", start: 0, end: 0 } : this.visitNode(macro, source);
	}

	public macro(ctx: CstNode["children"], source: string): MacroDocumentNode {
		const open = tokenFrom(ctx, "MacroOpen");
		const close = tokenFrom(ctx, "MacroClose");
		const headNode = nodeFrom(ctx, "macroHead");
		if (open === undefined || close === undefined || headNode === undefined) return { kind: "text", text: "", start: 0, end: 0 };
		const head = this.visitSequence(headNode, source);
		const header = parseHeader(head.raw);
		const start = open.startOffset ?? 0;
		const end = (close.endOffset ?? start) + 1;
		if (header === undefined) return { kind: "text", text: source.slice(start, end), start, end };
		const headerArgs = header.argumentStart === undefined ? [] : [sequenceSlice(
			head.nodes,
			(open.endOffset ?? start) + 1 + header.argumentStart,
			(open.endOffset ?? start) + 1 + header.argumentStart + (header.args[0]?.length ?? 0),
			source,
		)];
		const explicitArgs = [
			// ==[HUMAN APPROVED]== SAFETY: Chevrotain stores each grammar child as a CstNode; the
			// doubleColonArguments and singleColonArguments visitor rules return sequences.
			...(ctx.doubleColonArguments ?? []).map((node) => this.visit(cstNode(node), source) as MacroSequence[]).flat(),
			// ==[HUMAN APPROVED]== SAFETY: Chevrotain stores each grammar child as a CstNode; the
			// singleColonArguments visitor rule returns sequences.
			...(ctx.singleColonArguments ?? []).map((node) => this.visit(cstNode(node), source) as MacroSequence[]).flat(),
		];
		return {
			kind: "macro",
			name: header.name,
			flags: header.flags,
			args: [...headerArgs, ...explicitArgs],
			scope: undefined,
			raw: source.slice(start, end),
			start,
			end,
		};
	}

	public macroHead(ctx: CstNode["children"], source: string): MacroSequence {
		const elements = orderedElements([...(ctx.MacroPart ?? []), ...(ctx.macro ?? [])]);
		const nodes = elements.map((element): MacroDocumentNode => "image" in element
			? {
				kind: "text",
				text: element.image,
				start: element.startOffset ?? 0,
				end: (element.endOffset ?? (element.startOffset ?? 0)) + 1,
			}
			: this.visitNode(cstNode(element), source));
		const start = nodes[0]?.start ?? 0;
		const end = nodes.at(-1)?.end ?? start;
		return { nodes, start, end, raw: sequenceRaw(nodes) };
	}

	public macroArgument(ctx: CstNode["children"], source: string): MacroSequence {
		const elements = orderedElements([...(ctx.MacroPart ?? []), ...(ctx.Colon ?? []), ...(ctx.macro ?? [])]);
		const nodes = elements.map((element): MacroDocumentNode => "image" in element
			? {
				kind: "text",
				text: element.image,
				start: element.startOffset ?? 0,
				end: (element.endOffset ?? (element.startOffset ?? 0)) + 1,
			}
			: this.visitNode(cstNode(element), source));
		const first = elements[0];
		const last = elements.at(-1);
		const start = first === undefined
			? 0
			: "image" in first ? first.startOffset ?? 0 : first.location?.startOffset ?? 0;
		const end = last === undefined
			? start
			: "image" in last ? (last.endOffset ?? start - 1) + 1 : (last.location?.endOffset ?? start - 1) + 1;
		return { nodes, start, end, raw: sequenceRaw(nodes) };
	}

	public doubleColonArguments(ctx: CstNode["children"], source: string): MacroSequence[] {
		return (ctx.macroArgument ?? []).map((node) => this.visitSequence(cstNode(node), source));
	}

	public singleColonArguments(ctx: CstNode["children"], source: string): MacroSequence[] {
		return (ctx.macroArgument ?? []).map((node) => this.visitSequence(cstNode(node), source));
	}
}

const macroAstVisitor = new MacroAstVisitor();

const attachScopes = (nodes: readonly MacroDocumentNode[], source: string): MacroDocumentNode[] => {
	const pairs = new Map<number, number>();
	const literalPairs = new Map<number, number>();
	const openStacks = new Map<string, number[]>();
	const escapedCommentStack: number[] = [];
	for (const [index, node] of nodes.entries()) {
		if (node.kind === "text") continue;
		const escaped = isEscaped(source, node.start);
		if (node.name === "///" && !escaped) {
			const opener = openStacks.get("//")?.pop();
			if (opener !== undefined) pairs.set(opener, index);
			const escapedOpener = escapedCommentStack.pop();
			if (escapedOpener !== undefined) literalPairs.set(escapedOpener, index);
			continue;
		}
		if (node.flags.includes("/")) {
			if (escaped) continue;
			const opener = openStacks.get(node.name.toLowerCase())?.pop();
			if (opener !== undefined) pairs.set(opener, index);
			continue;
		}
		const commentScope = node.name === "//" && node.args.length === 0 && node.flags.length === 0;
		if (commentScope && escaped) {
			escapedCommentStack.push(index);
			continue;
		}
		if (!escaped) {
			if (node.name === "//" && !commentScope) continue;
			const stack = openStacks.get(node.name.toLowerCase()) ?? [];
			stack.push(index);
			openStacks.set(node.name.toLowerCase(), stack);
		}
	}

	const withArguments = (node: MacroNode): MacroNode => ({
		...node,
		args: node.args.map((argument) => ({ ...argument, nodes: attachScopes(argument.nodes, source) })),
	});
	const build = (start: number, end: number): MacroDocumentNode[] => {
		const result: MacroDocumentNode[] = [];
		for (let index = start; index < end; index += 1) {
			const node = nodes[index];
			if (node === undefined) continue;
			if (node.kind === "text") {
				result.push(node);
				continue;
			}
			const literalClose = node.name === "///" || node.flags.includes("/");
			if (literalClose) {
				result.push({ kind: "text", text: node.raw, start: node.start, end: node.end });
				continue;
			}
			const literalEnd = literalPairs.get(index);
			if (literalEnd !== undefined) {
				const close = nodes[literalEnd];
				result.push({ kind: "text", text: source.slice(node.start, close?.end ?? node.end), start: node.start, end: close?.end ?? node.end });
				index = literalEnd;
				continue;
			}
			const closeIndex = pairs.get(index);
			if (closeIndex === undefined) {
				result.push(withArguments(node));
				continue;
			}
			const close = nodes[closeIndex];
			if (close === undefined || close.kind === "text") {
				result.push(withArguments(node));
				continue;
			}
			result.push({
				...withArguments(node),
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

export const parseMacroDocument = (source: string): MacroDocumentNode[] => {
	const lexed = macroLexer.tokenize(source);
	documentParser.input = lexed.tokens;
	const tree = documentParser.document();
	if (lexed.errors.length > 0 || documentParser.errors.length > 0) return [{ kind: "text", text: source, start: 0, end: source.length }];
	// ==[HUMAN APPROVED]== SAFETY: the validated visitor returns the document's MacroDocumentNode list.
	return attachScopes(macroAstVisitor.visit(tree, source) as MacroDocumentNode[], source);
};
