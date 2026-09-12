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
}

export interface MacroNode {
	readonly kind: "macro";
	readonly name: string;
	readonly flags: readonly string[];
	readonly args: readonly string[];
	readonly scope: string | undefined;
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

const parseHeader = (body: string): { name: string; flags: string[]; args: string[] } | undefined => {
	let text = body.trim();
	const flags: string[] = [];
	if (text === "//" || text === "///") return { name: text, flags, args: [] };
	if (text.startsWith("//")) return { name: "//", flags, args: text.slice(2).trim() === "" ? [] : [text.slice(2).trim()] };
	while (text.length > 0 && "#!/".includes(text[0] ?? "")) {
		flags.push(text[0] ?? "");
		text = text.slice(1).trimStart();
	}
	const nameMatch = text.match(/^([A-Za-z](?:[\w-]*[\w])?|[.$][A-Za-z](?:[\w-]*[\w])?|\/\/|\/\/\/)(.*)$/s);
	if (nameMatch === null) return undefined;
	const name = nameMatch[1];
	const tail = nameMatch[2].trim();
	if (name === "///" || tail === "") return { name, flags, args: [] };
	return { name, flags, args: [tail] };
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

	private visitString(node: CstNode, source: string): string {
		// ==[HUMAN APPROVED]== SAFETY: macroHead and its segment rules reconstruct only source text.
		return this.visit(node, source) as string;
	}

	private visitArguments(node: CstNode, source: string): string[] {
		// ==[HUMAN APPROVED]== SAFETY: argument visitor rules return one ordered string list.
		return this.visit(node, source) as string[];
	}

	public document(ctx: CstNode["children"], source: string): MacroDocumentNode[] {
		return (ctx.documentPart ?? []).map((part) => this.visitNode(cstNode(part), source));
	}

	public documentPart(ctx: CstNode["children"], source: string): MacroDocumentNode {
		const text = tokenFrom(ctx, "DocumentText");
		if (text !== undefined) return { kind: "text", text: text.image };
		const macro = nodeFrom(ctx, "macro");
		return macro === undefined ? { kind: "text", text: "" } : this.visitNode(macro, source);
	}

	public macro(ctx: CstNode["children"], source: string): MacroDocumentNode {
		const open = tokenFrom(ctx, "MacroOpen");
		const close = tokenFrom(ctx, "MacroClose");
		const headNode = nodeFrom(ctx, "macroHead");
		if (open === undefined || close === undefined || headNode === undefined) return { kind: "text", text: "" };
		const header = parseHeader(this.visitString(headNode, source));
		const start = open.startOffset ?? 0;
		const end = (close.endOffset ?? start) + 1;
		if (header === undefined) return { kind: "text", text: source.slice(start, end) };
		const explicitArgs = [
			...(ctx.doubleColonArguments ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat(),
			...(ctx.singleColonArguments ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat(),
		].map((value) => value.trim());
		return {
			kind: "macro",
			name: header.name,
			flags: header.flags,
			args: [...header.args, ...explicitArgs],
			scope: undefined,
			raw: source.slice(start, end),
			start,
			end,
		};
	}

	public macroHead(ctx: CstNode["children"], source: string): string {
		return orderedElements([...(ctx.MacroPart ?? []), ...(ctx.macro ?? [])]).map((element) => "image" in element
			? element.image
			: nodeText(this.visitNode(cstNode(element), source))).join("");
	}

	public macroArgument(ctx: CstNode["children"], source: string): string[] {
		return [orderedElements([...(ctx.MacroPart ?? []), ...(ctx.Colon ?? []), ...(ctx.macro ?? [])]).map((element) => "image" in element
			? element.image
			: nodeText(this.visitNode(cstNode(element), source))).join("")];
	}

	public doubleColonArguments(ctx: CstNode["children"], source: string): string[] {
		return (ctx.macroArgument ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat();
	}

	public singleColonArguments(ctx: CstNode["children"], source: string): string[] {
		return (ctx.macroArgument ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat();
	}
}

const macroAstVisitor = new MacroAstVisitor();

const attachScopes = (nodes: readonly MacroDocumentNode[], source: string): MacroDocumentNode[] => {
	const scoped: MacroDocumentNode[] = [];
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (node === undefined || node.kind === "text") {
			if (node !== undefined) scoped.push(node);
			continue;
		}
		if (node.name === "///" || node.flags.includes("/")) {
			scoped.push({ kind: "text", text: node.raw });
			continue;
		}
		if (node.name === "//" && isEscaped(source, node.start)) {
			let escapedEnd = node.end;
			for (let candidateIndex = index + 1; candidateIndex < nodes.length; candidateIndex += 1) {
				const candidate = nodes[candidateIndex];
				if (candidate?.kind === "macro" && candidate.name === "///" && !isEscaped(source, candidate.start)) {
					escapedEnd = candidate.end;
					index = candidateIndex;
					break;
				}
			}
			scoped.push({ kind: "text", text: source.slice(node.start, escapedEnd) });
			continue;
		}
		const commentScope = node.name === "//" && node.args.length === 0 && node.flags.length === 0;
		if (commentScope) {
			const commentEnd = promptCommentEnd(source, node.start);
			const commentCloseIndex = commentEnd === null ? undefined : nodes.findIndex((candidate, candidateIndex) =>
				candidateIndex > index && candidate.kind === "macro" && candidate.name === "///" && candidate.end === commentEnd && !isEscaped(source, candidate.start));
			if (commentCloseIndex === undefined || commentCloseIndex < 0) {
				scoped.push(node);
				continue;
			}
			const commentClose = nodes[commentCloseIndex];
			if (commentClose === undefined || commentClose.kind === "text") {
				scoped.push(node);
				continue;
			}
			scoped.push({ ...node, scope: source.slice(node.end, commentClose.start), raw: source.slice(node.start, commentClose.end), end: commentClose.end });
			index = commentCloseIndex;
			continue;
		}
		let depth = 0;
		let closeIndex: number | undefined;
		for (let candidateIndex = index + 1; candidateIndex < nodes.length; candidateIndex += 1) {
			const candidate = nodes[candidateIndex];
			if (candidate === undefined || candidate.kind === "text") continue;
			const candidateName = candidate.name.toLowerCase();
			if (candidateName !== node.name.toLowerCase()) continue;
			if (candidate.flags.includes("/") && !isEscaped(source, candidate.start)) {
				if (depth === 0) {
					closeIndex = candidateIndex;
					break;
				}
				depth -= 1;
			} else depth += 1;
		}
		if (closeIndex === undefined) {
			scoped.push(node);
			continue;
		}
		const close = nodes[closeIndex];
		if (close === undefined || close.kind === "text") {
			scoped.push(node);
			continue;
		}
		scoped.push({ ...node, scope: source.slice(node.end, close.start), raw: source.slice(node.start, close.end), end: close.end });
		index = closeIndex;
	}
	return scoped;
};

export const parseMacroDocument = (source: string): MacroDocumentNode[] => {
	const lexed = macroLexer.tokenize(source);
	documentParser.input = lexed.tokens;
	const tree = documentParser.document();
	if (lexed.errors.length > 0 || documentParser.errors.length > 0) return [{ kind: "text", text: source }];
	// ==[HUMAN APPROVED]== SAFETY: the validated visitor returns the document's MacroDocumentNode list.
	return attachScopes(macroAstVisitor.visit(tree, source) as MacroDocumentNode[], source);
};
