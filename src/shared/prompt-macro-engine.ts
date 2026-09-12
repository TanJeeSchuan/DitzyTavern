import {
	CstParser,
	Lexer,
	createToken,
	type CstNode,
	type IToken,
} from "chevrotain";
import type { PromptWarning } from "./contract/conversation-schema";
import { isMacroVariableName, type MacroValue, type MacroVariableWrite } from "./contract/macro-variables";

export type { MacroValue, MacroVariableWrite } from "./contract/macro-variables";

// ==[HUMAN APPROVED]== Explicit inputs for one expansion. The evaluator never reads browser
// globals, a database, or the wall clock. A Map is intentionally accepted so a compiler can
// thread one local attempt state through ordered authored blocks.
export interface MacroEnvironment {
	readonly self: string;
	readonly other: string;
	readonly conversationId?: string | number;
	readonly promptPresetId?: string | number;
	readonly now?: Date;
	readonly timeZone?: string;
	readonly locale?: string;
	readonly variables?: ReadonlyMap<string, MacroValue> | Readonly<Record<string, MacroValue>>;
	// ==[HUMAN APPROVED]== One expansion may execute several authored blocks. The caller supplies
	// this journal so resolved writes can be carried to the Variant that owns the attempt.
	readonly writes?: MacroVariableWrite[];
	readonly random?: () => number;
	readonly macroPositionBase?: string | number;
	// ==[HUMAN APPROVED]== Cached authored expansions reused by budget recompilation.
	readonly expansionCache?: Map<string, MacroExpansionResult>;
}

export interface MacroExpansionResult {
	readonly text: string;
	readonly warnings: readonly PromptWarning[];
	readonly writes: readonly MacroVariableWrite[];
}

export interface MacroValidationResult {
	readonly warnings: readonly PromptWarning[];
}

interface TextNode {
	readonly kind: "text";
	readonly text: string;
}

interface MacroNode {
	readonly kind: "macro";
	readonly name: string;
	readonly flags: readonly string[];
	readonly args: readonly string[];
	readonly scope: string | undefined;
	readonly raw: string;
	readonly start: number;
	readonly end: number;
}

type Node = TextNode | MacroNode;

const isEscaped = (source: string, index: number): boolean => {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
	return slashes % 2 === 1;
};

const balancedMacroAt = (source: string, start: number): boolean => {
	if (!source.startsWith("{{", start)) return false;
	let depth = 0;
	for (let index = start; index < source.length - 1; index += 1) {
		if (source.startsWith("{{", index)) {
			depth += 1;
			index += 1;
			continue;
		}
		if (source.startsWith("}}", index) && !isEscaped(source, index)) {
			depth -= 1;
			if (depth === 0) return true;
			index += 1;
		}
	}
	return false;
};

const openPattern = (source: string, offset: number): [string] | null =>
	balancedMacroAt(source, offset) ? ["{{"] : null;

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
	if (balancedMacroAt(source, offset)) return null;
	let end = offset;
	while (end < source.length) {
		if (balancedMacroAt(source, end)) break;
		end += 1;
	}
	return end === offset ? null : [source.slice(offset, end)];
};

const macroPartPattern = (source: string, offset: number): [string] | null => {
	let end = offset;
	while (end < source.length) {
		if (
			balancedMacroAt(source, end) ||
			closePattern(source, end) !== null ||
			source.startsWith("::", end) ||
			singleColonPattern(source, end) !== null
		) break;
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

interface ParsedMacro {
	readonly kind: "parsed-macro";
	readonly header: string;
	readonly args: readonly string[];
	readonly raw: string;
	readonly start: number;
	readonly end: number;
}

type ParsedNode = TextNode | ParsedMacro;
type MacroSource = string;

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

	public macroArgumentDouble = this.RULE("macroArgumentDouble", () => {
		this.MANY(() => this.OR([
			{ ALT: () => this.CONSUME(MacroPart) },
			{ ALT: () => this.CONSUME(Colon) },
			{ ALT: () => this.SUBRULE(this.macro) },
		]));
	});

	public macroArgumentSingle = this.RULE("macroArgumentSingle", () => {
		this.MANY(() => this.OR([
			{ ALT: () => this.CONSUME(MacroPart) },
			{ ALT: () => this.CONSUME(Colon) },
			{ ALT: () => this.SUBRULE(this.macro) },
		]));
	});

	public doubleColonArguments = this.RULE("doubleColonArguments", () => {
		this.AT_LEAST_ONE(() => {
			this.CONSUME(DoubleColon);
			this.SUBRULE(this.macroArgumentDouble);
		});
	});

	public singleColonArguments = this.RULE("singleColonArguments", () => {
		this.CONSUME(Colon);
		this.SUBRULE(this.macroArgumentSingle);
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

const orderedElements = (
	elements: readonly (CstNode | IToken)[],
): (CstNode | IToken)[] => [...elements].sort((left, right) =>
	("image" in left ? left.startOffset ?? 0 : left.location?.startOffset ?? 0) -
	("image" in right ? right.startOffset ?? 0 : right.location?.startOffset ?? 0));

const parsedNodeText = (node: ParsedNode): string => node.kind === "parsed-macro" ? node.raw : node.text;

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
	if (name === "///") return { name, flags, args: [] };
	if (tail === "") return { name, flags, args: [] };
	// ==[HUMAN APPROVED]== SillyTavern's whitespace separator accepts one or more spaces after the name.
	return { name, flags, args: [tail] };
};

class MacroAstVisitor extends documentParser.getBaseCstVisitorConstructorWithDefaults() {
	constructor() {
		super();
		this.validateVisitor();
	}

	private visitNode(node: CstNode, source: MacroSource): ParsedNode {
		// ==[HUMAN APPROVED]== SAFETY: The CST rule's visitor result is restricted to the parsed macro/text union.
		return this.visit(node, source) as ParsedNode;
	}

	private visitString(node: CstNode, source: MacroSource): string {
		// ==[HUMAN APPROVED]== SAFETY: Segment visitor rules return only their reconstructed source string.
		return this.visit(node, source) as string;
	}

	private visitArguments(node: CstNode, source: MacroSource): string[] {
		// ==[HUMAN APPROVED]== SAFETY: Argument visitor rules return one ordered list of parsed argument text.
		return this.visit(node, source) as string[];
	}

	public document(ctx: CstNode["children"], source: MacroSource): ParsedNode[] {
		return (ctx.documentPart ?? []).map((part) => {
			return this.visitNode(cstNode(part), source);
		});
	}

	public documentPart(ctx: CstNode["children"], source: MacroSource): ParsedNode {
		const text = tokenFrom(ctx, "DocumentText");
		if (text !== undefined) return { kind: "text", text: text.image };
		const macro = nodeFrom(ctx, "macro");
		if (macro === undefined) return { kind: "text", text: "" };
		return this.visitNode(macro, source);
	}

	public macro(ctx: CstNode["children"], source: MacroSource): ParsedNode {
		const open = tokenFrom(ctx, "MacroOpen");
		const close = tokenFrom(ctx, "MacroClose");
		const headNode = nodeFrom(ctx, "macroHead");
		if (open === undefined || close === undefined || headNode === undefined) {
			return { kind: "text", text: "" };
		}
		const header = this.visitString(headNode, source);
		const parsedHeader = parseHeader(header);
		const doubleArguments = (ctx.doubleColonArguments ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat();
		const singleArguments = (ctx.singleColonArguments ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat();
		if (parsedHeader === undefined) return { kind: "text", text: source.slice(open.startOffset ?? 0, (close.endOffset ?? 0) + 1) };
		const start = open.startOffset ?? 0;
		const end = (close.endOffset ?? start) + 1;
		return {
			kind: "parsed-macro",
			header: header,
			args: [...parsedHeader.args, ...doubleArguments, ...singleArguments],
			raw: source.slice(start, end),
			start,
			end,
		};
	}

	public macroHead(ctx: CstNode["children"], source: MacroSource): string {
		return orderedElements([
			...(ctx.MacroPart ?? []),
			...(ctx.macro ?? []),
		]).map((element) => "image" in element
			? element.image
			: parsedNodeText(this.visitNode(cstNode(element), source))).join("");
	}

	public macroArgumentDouble(ctx: CstNode["children"], source: MacroSource): string[] {
		return [orderedElements([
			...(ctx.MacroPart ?? []),
			...(ctx.Colon ?? []),
			...(ctx.macro ?? []),
		]).map((element) => "image" in element
			? element.image
			: parsedNodeText(this.visitNode(cstNode(element), source))).join("")];
	}

	public macroArgumentSingle(ctx: CstNode["children"], source: MacroSource): string[] {
		return [orderedElements([
			...(ctx.MacroPart ?? []),
			...(ctx.Colon ?? []),
			...(ctx.macro ?? []),
		]).map((element) => "image" in element
			? element.image
			: parsedNodeText(this.visitNode(cstNode(element), source))).join("")];
	}

	public doubleColonArguments(ctx: CstNode["children"], source: MacroSource): string[] {
		return (ctx.macroArgumentDouble ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat().map((value) => value.trim());
	}

	public singleColonArguments(ctx: CstNode["children"], source: MacroSource): string[] {
		return (ctx.macroArgumentSingle ?? []).map((node) => this.visitArguments(cstNode(node), source)).flat().map((value) => value.trim());
	}
}

const macroAstVisitor = new MacroAstVisitor();

const parseDocument = (source: string): Node[] => {
	const lexed = macroLexer.tokenize(source);
	documentParser.input = lexed.tokens;
	const tree = documentParser.document();
	if (lexed.errors.length > 0 || documentParser.errors.length > 0) return [{ kind: "text", text: source }];
	// ==[HUMAN APPROVED]== SAFETY: The root document visitor returns the parser's ParsedNode list.
	const parsed = macroAstVisitor.visit(tree, source) as ParsedNode[];
	const nodes = parsed.flatMap((node): Node[] => node.kind === "parsed-macro"
		? (() => {
				const parsedHeader = parseHeader(node.header);
				if (parsedHeader === undefined) return [{ kind: "text", text: node.raw }];
				return [{
					kind: "macro",
					name: parsedHeader.name,
					flags: parsedHeader.flags,
					args: [...parsedHeader.args, ...node.args.slice(parsedHeader.args.length)],
					scope: undefined,
					raw: node.raw,
					start: node.start,
					end: node.end,
				}];
			})()
		: [node]);
	return attachScopes(nodes, source);
};

const attachScopes = (nodes: readonly Node[], source: string): Node[] => {
	const scoped: Node[] = [];
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
		let depth = 0;
		let closeIndex: number | undefined;
		for (let candidateIndex = index + 1; candidateIndex < nodes.length; candidateIndex += 1) {
			const candidate = nodes[candidateIndex];
			if (candidate === undefined || candidate.kind === "text") continue;
			const candidateName = candidate.name.toLowerCase();
			if (commentScope) {
			if (candidateName === "///" && !isEscaped(source, candidate.start)) {
					closeIndex = candidateIndex;
					break;
				}
				continue;
			}
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
		scoped.push({
			...node,
			scope: source.slice(node.end, close.start),
			raw: source.slice(node.start, close.end),
			end: close.end,
		});
		index = closeIndex;
	}
	return scoped;
};

const cloneVariables = (variables: MacroEnvironment["variables"]): Map<string, MacroValue> =>
	// ==[HUMAN APPROVED]== A Map is the explicit attempt-local state seam. Reusing it is what lets recipe blocks observe
	// writes from earlier enabled blocks; record snapshots are cloned at the domain boundary.
	variables instanceof Map ? variables : new Map(Object.entries(variables ?? {}));

const normalize = (value: MacroValue | undefined): string => {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return JSON.stringify(value);
	return String(value);
};

const asNumber = (value: string | number): number | undefined => {
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
};

const randomFloat = (environment: MacroEnvironment): number => {
	const value = environment.random?.() ?? Math.random();
	return Number.isFinite(value) && value >= 0 && value < 1 ? value : Math.abs(value % 1);
};

const randomInteger = (environment: MacroEnvironment, maximum: number): number =>
	Math.floor(randomFloat(environment) * maximum) + 1;

const hash = (text: string): number => {
	let result = 2166136261;
	for (const character of text) {
		result ^= character.codePointAt(0) ?? 0;
		result = Math.imul(result, 16777619);
	}
	return result >>> 0;
};

const listArguments = (args: readonly string[]): string[] => {
	if (args.length > 1) return args.map((arg) => arg.replaceAll("\\,", ","));
	const value = args[0] ?? "";
	const result: string[] = [];
	let current = "";
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "\\" && value[index + 1] === ",") {
			current += ",";
			index += 1;
		} else if (value[index] === ",") {
			result.push(current.trim());
			current = "";
		} else current += value[index];
	}
	result.push(current.trim());
	return result;
};

const dedent = (value: string): string => {
	const lines = value.split("\n");
	const indents = lines
		.filter((line) => line.trim() !== "")
		.map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
	const minimum = indents.length === 0 ? 0 : Math.min(...indents);
	return lines.map((line) => line.slice(Math.min(minimum, line.match(/^[ \t]*/)?.[0].length ?? 0))).join("\n");
};

const scopedContent = (value: string, preserve: boolean): string => preserve ? value : dedent(value).trim();

const falsy = (value: string): boolean => {
	const normalized = value.trim().toLowerCase();
	return normalized === "" || normalized === "0" || normalized === "off" || normalized === "false" || normalized === "no";
};

const utcOffsetMinutes = (value: string): number | undefined => {
	const match = value.match(/^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i);
	if (match === null) return undefined;
	const hours = Number(match[2]);
	const minutes = Number(match[3] ?? 0);
	if (hours > 23 || minutes > 59) return undefined;
	return (match[1] === "+" ? 1 : -1) * (hours * 60 + minutes);
};

const dateForTimeZone = (date: Date, timeZone: string): { date: Date; intlTimeZone: string } => {
	const offset = utcOffsetMinutes(timeZone);
	return offset === undefined
		? { date, intlTimeZone: timeZone }
		: { date: new Date(date.getTime() + offset * 60_000), intlTimeZone: "UTC" };
};

const dateParts = (date: Date, timeZone: string, locale: string) => {
	const target = dateForTimeZone(date, timeZone);
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat(locale, {
			timeZone: target.intlTimeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			weekday: "long",
			hourCycle: "h23",
		});
	} catch {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: "UTC",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			weekday: "long",
			hourCycle: "h23",
		});
	}
	const parts = Object.fromEntries(formatter.formatToParts(target.date).map((part) => [part.type, part.value]));
	return {
		year: parts.year ?? "",
		month: parts.month ?? "",
		day: parts.day ?? "",
		hour: parts.hour ?? "",
		minute: parts.minute ?? "",
		second: parts.second ?? "",
		weekday: parts.weekday ?? "",
	};
};

const timezoneOf = (value: string | undefined, fallback: string): string => {
	if (value === undefined || value === "") return fallback;
	const offset = utcOffsetMinutes(value);
	if (offset === undefined && !/^UTC[+-]/i.test(value)) {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
			return value;
		} catch {
			return fallback;
		}
	}
	return offset === undefined ? fallback : value;
};

const localeOf = (value: string | undefined): string => {
	if (value === undefined || value === "") return "en-US";
	try {
		new Intl.DateTimeFormat(value).format();
		return value;
	} catch {
		return "en-US";
	}
};

const formatDate = (date: Date, format: string, environment: MacroEnvironment, timezoneArg?: string): string => {
	const timezone = timezoneOf(timezoneArg, timezoneOf(environment.timeZone, "UTC"));
	const locale = localeOf(environment.locale);
	const target = dateForTimeZone(date, timezone);
	const parts = dateParts(date, timezone, locale);
	if (format === "LT") {
		return new Intl.DateTimeFormat(locale, { timeZone: target.intlTimeZone, hour: "numeric", minute: "2-digit" }).format(target.date);
	}
	if (format === "LL") {
		return new Intl.DateTimeFormat(locale, { timeZone: target.intlTimeZone, year: "numeric", month: "long", day: "numeric" }).format(target.date);
	}
	return format
		.replaceAll("YYYY", parts.year)
		.replaceAll("MMMM", new Intl.DateTimeFormat(locale, { timeZone: target.intlTimeZone, month: "long" }).format(target.date))
		.replaceAll("MMM", new Intl.DateTimeFormat(locale, { timeZone: target.intlTimeZone, month: "short" }).format(target.date))
		.replaceAll("dddd", parts.weekday)
		.replaceAll("DD", parts.day)
		.replaceAll("MM", parts.month)
		.replaceAll("HH", parts.hour)
		.replaceAll("mm", parts.minute)
		.replaceAll("ss", parts.second);
};

const humanizeDuration = (milliseconds: number): string => {
	const seconds = Math.round(Math.abs(milliseconds) / 1000);
	if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? "" : "s"}`;
};

const dice = (formula: string, environment: MacroEnvironment): string => {
	const match = formula.trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i) ?? formula.trim().match(/^(\d+)$/);
	if (match === null) return "";
	if (match.length === 2) {
		const sides = Number(match[1]);
		return Number.isSafeInteger(sides) && sides > 0 ? String(randomInteger(environment, sides)) : "";
	}
	const count = Number(match[1] || 1);
	const sides = Number(match[2]);
	const modifier = Number(match[3] ?? 0);
	if (!Number.isSafeInteger(count) || !Number.isSafeInteger(sides) || count < 1 || sides < 1) return "";
	let total = modifier;
	for (let index = 0; index < count; index += 1) total += randomInteger(environment, sides);
	return String(total);
};

const isDiceFormula = (formula: string): boolean =>
	/^(\d*)d(\d+)([+-]\d+)?$/i.test(formula.trim()) || /^(\d+)$/.test(formula.trim());

interface EvaluationState {
	readonly environment: MacroEnvironment;
	readonly variables: Map<string, MacroValue>;
	readonly writes: MacroVariableWrite[];
	readonly warnings: PromptWarning[];
	readonly blockLabel: string;
	readonly validationOnly: boolean;
}

const warningFor = (state: EvaluationState, node: MacroNode) => {
	state.warnings.push({ block: state.blockLabel, macro: node.raw });
};

const variable = (state: EvaluationState, name: string): string => normalize(state.variables.get(name));

const setVariable = (state: EvaluationState, name: string, value: MacroValue): void => {
	state.variables.set(name, value);
	if (!state.validationOnly) {
		const write = { name, value, operation: "set" } as const;
		state.writes.push(write);
		state.environment.writes?.push(write);
	}
};

const deleteVariable = (state: EvaluationState, name: string): void => {
	state.variables.delete(name);
	if (!state.validationOnly) {
		const write = { name, value: undefined, operation: "delete" } as const;
		state.writes.push(write);
		state.environment.writes?.push(write);
	}
};

const addVariable = (state: EvaluationState, name: string, addition: string | number): string => {
	const currentValue = state.variables.get(name);
	if (Array.isArray(currentValue)) {
		setVariable(state, name, [...currentValue, addition]);
		return variable(state, name);
	}
	const current = asNumber(currentValue === undefined ? "" : normalize(currentValue));
	const amount = asNumber(addition);
	setVariable(
		state,
		name,
		current !== undefined && amount !== undefined
			? current + amount
			: `${variable(state, name)}${addition}`,
	);
	return variable(state, name);
};

const evaluateText = (source: string, state: EvaluationState): string => {
	const nodes = parseDocument(source);
	let output = "";
	for (const node of nodes) {
		if (node.kind === "text") {
			output += node.text;
			continue;
		}
		output += evaluateMacro(node, state);
	}
	return output
		.replace(/(?:\r?\n)?__DITZY_TRIM_SENTINEL__(?:\r?\n)?/g, "")
		// ==[HUMAN APPROVED]== Split braces (`\{\{`) are an escape for literal delimiters. An
		// adjacent `\{{` is authored text before an active macro, and must keep
		// its backslash; Prompt Comments use that same literal-prefix rule.
		.replace(/\\(?=[{}])(?!\{\{|}})/g, "");
};

const evaluateCondition = (condition: string, state: EvaluationState, node: MacroNode): string | undefined => {
	const shorthand = condition.match(/^([.$])([A-Za-z](?:[\w-]*[\w])?)(?:\s*(\|\|=|\?\?=|\|\||\?\?|\+\+|--|\+=|-=|==|!=|>=|<=|>|<|=)\s*(.*))?$/s);
	if (shorthand !== null) {
		if (shorthand[1] === "$") {
			warningFor(state, node);
			return undefined;
		}
		const name = shorthand[2];
		const operator = shorthand[3];
		const rhs = shorthand[4] ?? "";
		const current = variable(state, name);
		if (operator === undefined) return current;
		if (state.validationOnly) {
			if (operator !== undefined) evaluateText(rhs, state);
			return "";
		}
		if (operator === "==" || operator === "!=") return String(operator === "==" ? current === evaluateText(rhs, state) : current !== evaluateText(rhs, state));
		if ([">", ">=", "<", "<="].includes(operator)) {
			const left = asNumber(current);
			const right = asNumber(evaluateText(rhs, state));
			if (left === undefined || right === undefined) return "false";
			return String(operator === ">" ? left > right : operator === ">=" ? left >= right : operator === "<" ? left < right : left <= right);
		}
		if (operator === "||") return falsy(current) ? evaluateText(rhs, state) : current;
		if (operator === "??") return state.variables.has(name) ? current : evaluateText(rhs, state);
		if (operator === "||=") {
			if (falsy(current)) setVariable(state, name, evaluateText(rhs, state));
			return variable(state, name);
		}
		if (operator === "??=") {
			if (!state.variables.has(name)) setVariable(state, name, evaluateText(rhs, state));
			return variable(state, name);
		}
		const evaluated = evaluateText(rhs, state);
		if (operator === "=") {
			setVariable(state, name, evaluated);
			return "";
		}
		if (operator === "++") return addVariable(state, name, 1);
		if (operator === "--") return addVariable(state, name, -1);
		if (operator === "+=") {
			addVariable(state, name, evaluated);
			return "";
		}
		if (operator === "-=") {
			const left = asNumber(current);
			const right = asNumber(evaluated);
			if (left === undefined || right === undefined) {
				warningFor(state, node);
				return "";
			}
			setVariable(state, name, left - right);
			return "";
		}
		return variable(state, name);
	}
	return evaluateText(condition, state);
};

const splitElse = (source: string): [string, string | undefined] => {
	const nodes = parseDocument(source);
	const index = nodes.findIndex((node) => node.kind === "macro" && node.name.toLowerCase() === "else");
	if (index === -1) return [source, undefined];
	const left = nodes.slice(0, index).map((node) => node.kind === "text" ? node.text : node.raw).join("");
	const right = nodes.slice(index + 1).map((node) => node.kind === "text" ? node.text : node.raw).join("");
	return [left, right];
};

const evaluateMacro = (node: MacroNode, state: EvaluationState): string => {
	const name = node.name.toLowerCase();
	if (name === "///" || name === "else") return "";
	if (node.name.startsWith(".")) {
		return evaluateCondition(`${node.name}${node.args[0] ?? ""}`, state, node) ?? node.raw;
	}
	if (node.name.startsWith("$")) {
		warningFor(state, node);
		return node.raw;
	}
	if (name === "//" || name === "comment") return "";
	if (name === "if") {
		const condition = evaluateCondition(node.args[0] ?? "", state, node);
		const content = node.scope ?? node.args[1] ?? "";
		const [whenTrue, whenFalseFromScope] = splitElse(scopedContent(content, node.flags.includes("#")));
		const whenFalse = node.scope === undefined ? node.args[2] : whenFalseFromScope;
		if (state.validationOnly) {
			// ==[HUMAN APPROVED]== Validation must inspect both branches without choosing one or
			// executing its runtime effects.
			evaluateText(whenTrue, state);
			evaluateText(whenFalse ?? "", state);
			return "";
		}
		if (condition === undefined) return node.raw;
		const useTrue = node.flags.includes("!") ? falsy(condition) : !falsy(condition);
		const chosen = useTrue ? whenTrue : whenFalse;
		return evaluateText(chosen ?? "", state);
	}

	const args = node.args.map((arg) => evaluateText(arg, state));
	if (name === "self") return state.environment.self;
	if (name === "other") return state.environment.other;
	if (name === "space") return " ".repeat(Math.max(0, Math.trunc(Number(args[0] ?? 1) || 0)));
	if (name === "newline") return "\n".repeat(Math.max(0, Math.trunc(Number(args[0] ?? 1) || 0)));
	if (name === "noop") return "";
	if (name === "trim") return node.scope === undefined ? "__DITZY_TRIM_SENTINEL__" : scopedContent(node.scope, node.flags.includes("#")).trim();
	if (name === "reverse") return Array.from(node.scope === undefined ? args[0] ?? "" : scopedContent(node.scope, node.flags.includes("#"))).reverse().join("");
	if (name === "random") {
		if (args.length === 0) {
			warningFor(state, node);
			return state.validationOnly ? "" : node.raw;
		}
		const choices = listArguments(args);
		if (choices.length === 1 && choices[0] === "") {
			warningFor(state, node);
			return state.validationOnly ? "" : node.raw;
		}
		if (state.validationOnly) return "";
		return choices.length === 0 ? "" : choices[Math.floor(randomFloat(state.environment) * choices.length)] ?? "";
	}
	if (name === "pick") {
		if (args.length === 0) {
			warningFor(state, node);
			return state.validationOnly ? "" : node.raw;
		}
		const choices = listArguments(args);
		if (choices.length === 1 && choices[0] === "") {
			warningFor(state, node);
			return state.validationOnly ? "" : node.raw;
		}
		if (choices.length === 0) return "";
		if (state.validationOnly) return "";
		const identity = `${state.environment.conversationId ?? ""}|${state.environment.promptPresetId ?? ""}|${state.environment.macroPositionBase ?? ""}|${node.raw}|${node.start}`;
		return choices[hash(identity) % choices.length] ?? "";
	}
	if (name === "roll") {
		if (args.length === 0) {
			warningFor(state, node);
			return state.validationOnly ? "" : node.raw;
		}
		if (!isDiceFormula(args[0] ?? "")) {
			warningFor(state, node);
			return state.validationOnly ? "" : node.raw;
		}
		if (state.validationOnly) return "";
		return dice(args[0] ?? "", state.environment);
	}
	if (name === "time" || name === "date" || name === "weekday" || name === "isotime" || name === "isodate" || name === "datetimeformat") {
		const now = state.environment.now ?? new Date(0);
		if (name === "time") return formatDate(now, "LT", state.environment, args[0]);
		if (name === "date") return formatDate(now, "LL", state.environment, args[0]);
		if (name === "weekday") return dateParts(now, timezoneOf(args[0], timezoneOf(state.environment.timeZone, "UTC")), localeOf(state.environment.locale)).weekday;
		if (name === "isotime") return formatDate(now, "HH:mm", state.environment, args[0]);
		if (name === "isodate") return formatDate(now, "YYYY-MM-DD", state.environment, args[0]);
		return formatDate(now, args[0] ?? "", state.environment, args[1]);
	}
	if (name === "timediff") {
		const then = Date.parse(args[0] ?? "");
		return Number.isNaN(then) ? "" : humanizeDuration((state.environment.now ?? new Date(0)).getTime() - then);
	}
	if ([
		"getvar", "varexists", "hasvar", "deletevar", "flushvar", "setvar", "addvar", "incvar", "decvar",
		"setlocalvar", "getlocalvar", "addlocalvar", "inclocalvar", "declocalvar", "haslocalvar",
		"deletelocalvar", "flushlocalvar",
	].includes(name)) {
		const variableName = args[0] ?? "";
		if (!isMacroVariableName(variableName)) {
			warningFor(state, node);
			return node.raw;
		}
		if (state.validationOnly) return "";
		if (name === "getvar" || name === "getlocalvar") return variable(state, variableName);
		if (name === "varexists" || name === "hasvar" || name === "haslocalvar") return String(state.variables.has(variableName));
		if (name === "deletevar" || name === "flushvar" || name === "deletelocalvar" || name === "flushlocalvar") {
			deleteVariable(state, variableName);
			return "";
		}
		if (name === "setvar" || name === "setlocalvar") {
			setVariable(state, variableName, args[1] ?? "");
			return "";
		}
		if (name === "incvar" || name === "decvar" || name === "inclocalvar" || name === "declocalvar") {
			return addVariable(state, variableName, name === "incvar" || name === "inclocalvar" ? 1 : -1);
		}
		addVariable(state, variableName, args[1] ?? "");
		return "";
	}

	warningFor(state, node);
	if (args.length === 0 && node.scope === undefined) return node.raw;
	const argumentText = args.length === 0 ? "" : `::${args.join("::")}`;
	const scopeContent = node.scope === undefined
		? ""
		: state.validationOnly
			? evaluateText(node.scope, state)
			: node.scope;
	const scopedText = node.scope === undefined ? "" : `${scopeContent}{{/${node.name}}}`;
	return `{{${node.name}${argumentText}}}${scopedText}`;
};

export const expandMacroText = (
	source: string,
	environment: MacroEnvironment,
	blockLabel: string,
	options: { validationOnly?: boolean } = {},
): MacroExpansionResult => {
	const state: EvaluationState = {
		environment,
		variables: cloneVariables(environment.variables),
		writes: [],
		warnings: [],
		blockLabel,
		validationOnly: options.validationOnly === true,
	};
	return {
		text: evaluateText(source, state),
		warnings: state.warnings,
		writes: state.writes,
	};
};

export const validateMacroText = (source: string, blockLabel: string): MacroValidationResult => ({
	warnings: expandMacroText(source, { self: "", other: "" }, blockLabel, { validationOnly: true }).warnings,
});
