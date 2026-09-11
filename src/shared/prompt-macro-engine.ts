import { createToken, EmbeddedActionsParser, createTokenInstance, type IToken } from "chevrotain";
import type { PromptWarning } from "./contract/conversation-schema";

// ==[HUMAN APPROVED]== Values a macro can carry while an authored block is being expanded.
export type MacroValue = string | number | boolean | null;

export interface MacroVariableWrite {
	readonly name: string;
	readonly value: MacroValue | undefined;
	readonly operation: "set" | "delete";
}

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

const PlainText = createToken({ name: "PlainText", pattern: /NOT_USED/ });
const MacroText = createToken({ name: "MacroText", pattern: /NOT_USED/ });

// ==[HUMAN APPROVED]== Chevrotain owns the document grammar. The source lexer below preserves
// arbitrary text allowed inside an argument and emits the two grammar tokens; this keeps
// malformed user-authored text literal while still giving the evaluator a real parser boundary.
class MacroDocumentParser extends EmbeddedActionsParser {
	private readonly parseDocumentRule: () => void;

	constructor() {
		super([PlainText, MacroText], { recoveryEnabled: true });
		this.parseDocumentRule = this.RULE("document", () => {
			this.MANY(() => this.OR([
				{ ALT: () => this.CONSUME(PlainText) },
				{ ALT: () => this.CONSUME(MacroText) },
			]));
		});
		this.performSelfAnalysis();
	}

	parse(tokens: IToken[]): void {
		this.input = tokens;
		this.parseDocumentRule();
	}
}

const documentParser = new MacroDocumentParser();

const isEscaped = (source: string, index: number): boolean => {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
	return slashes % 2 === 1;
};

const hasOpen = (source: string, index: number): boolean =>
	// ==[HUMAN APPROVED]== A leading backslash does not escape an adjacent `{{` in SillyTavern
	// syntax; only splitting the braces (`\{\{`) does.
	source.startsWith("{{", index);

const matchingEnd = (source: string, start: number): number | undefined => {
	let depth = 1;
	for (let index = start + 2; index < source.length - 1; index += 1) {
		if (hasOpen(source, index)) {
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
	return undefined;
};

const splitTopLevel = (source: string, separator: "::" | ":"): string[] => {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < source.length; index += 1) {
		if (hasOpen(source, index)) {
			depth += 1;
			index += 1;
			continue;
		}
		if (source.startsWith("}}", index) && depth > 0) {
			depth -= 1;
			index += 1;
			continue;
		}
		if (depth === 0 && source.startsWith(separator, index)) {
			parts.push(source.slice(start, index).trim());
			start = index + separator.length;
			index += separator.length - 1;
		}
	}
	parts.push(source.slice(start).trim());
	return parts;
};

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
	let tail = nameMatch[2].trim();
	if (name === "///") return { name, flags, args: [] };
	const legacyTimeZone = name.match(/^time_(UTC[+-]\d{1,2}(?::\d{2})?)$/i);
	if (legacyTimeZone !== null) return { name: "time", flags, args: [legacyTimeZone[1]] };
	if (tail === "") return { name, flags, args: [] };
	if (tail.startsWith("::")) return { name, flags, args: splitTopLevel(tail.slice(2), "::") };
	if (tail.startsWith(":")) return { name, flags, args: [tail.slice(1).trim()] };
	// ==[HUMAN APPROVED]== SillyTavern's whitespace separator accepts one or more spaces after the name.
	return { name, flags, args: [tail] };
};

const parseSimpleMacro = (source: string, start: number): MacroNode | undefined => {
	if (!hasOpen(source, start)) return undefined;
	const end = matchingEnd(source, start);
	if (end === undefined) return undefined;
	const parsed = parseHeader(source.slice(start + 2, end - 2));
	if (parsed === undefined) return undefined;
	return {
		kind: "macro",
		name: parsed.name,
		flags: parsed.flags,
		args: parsed.args,
		scope: undefined,
		raw: source.slice(start, end),
		start,
		end,
	};
};

const findScopedClose = (source: string, start: number, name: string): { start: number; end: number } | undefined => {
	const expected = name.toLowerCase();
	let depth = 0;
	for (let index = start; index < source.length - 1; index += 1) {
		if (!hasOpen(source, index)) continue;
		const node = parseSimpleMacro(source, index);
		if (node === undefined) continue;
		index = node.end - 1;
		const candidate = node.name.toLowerCase();
		if (name === "//") {
			if (candidate === "///") return { start: node.start, end: node.end };
			continue;
		}
		if (candidate === expected && node.flags.includes("/")) {
			if (depth === 0) return { start: node.start, end: node.end };
			depth -= 1;
			continue;
		}
		if (candidate === expected && !node.flags.includes("/")) depth += 1;
	}
	return undefined;
};

const parseDocument = (source: string): Node[] => {
	const nodes: Node[] = [];
	const tokenInstances = [];
	let textStart = 0;
	const flushText = (end: number) => {
		if (end <= textStart) return;
		const text = source.slice(textStart, end);
		nodes.push({ kind: "text", text });
		tokenInstances.push(createTokenInstance(PlainText, text, textStart, end - 1, NaN, NaN, NaN, NaN));
	};
	for (let index = 0; index < source.length; index += 1) {
		if (!hasOpen(source, index)) continue;
		const node = parseSimpleMacro(source, index);
		if (node === undefined) continue;
		// ==[HUMAN APPROVED]== A scoped closing tag is consumed together with its opening node. A
		// closing tag without an opening pair remains authored text.
		if (node.name === "///" || node.flags.includes("/")) continue;
		flushText(index);
		let full = node;
		const scopeClose = findScopedClose(source, node.end, node.name === "//" ? "//" : node.name);
		if (scopeClose !== undefined) {
			full = {
				...node,
				scope: source.slice(node.end, scopeClose.start),
				raw: source.slice(node.start, scopeClose.end),
				end: scopeClose.end,
			};
		}
		nodes.push(full);
		tokenInstances.push(createTokenInstance(MacroText, full.raw, full.start, full.end - 1, NaN, NaN, NaN, NaN));
		index = full.end - 1;
		textStart = full.end;
	}
	flushText(source.length);
	documentParser.parse(tokenInstances);
	return nodes;
};

const cloneVariables = (variables: MacroEnvironment["variables"]): Map<string, MacroValue> =>
	variables instanceof Map ? variables : new Map(Object.entries(variables ?? {}));

const normalize = (value: MacroValue | undefined): string => value === null || value === undefined ? "" : String(value);

const asNumber = (value: string): number | undefined => {
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

const dateParts = (date: Date, timeZone: string, locale: string) => {
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat(locale, {
			timeZone,
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
	const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
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
	const utc = value.match(/^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i);
	if (utc === null) {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
			return value;
		} catch {
			return fallback;
		}
	}
	const hours = Number(utc[2]);
	const minutes = Number(utc[3] ?? 0);
	const offset = (utc[1] === "+" ? 1 : -1) * (hours * 60 + minutes);
	return `Etc/GMT${offset <= 0 ? "+" : "-"}${Math.abs(Math.trunc(offset / 60))}`;
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
	const parts = dateParts(date, timezone, locale);
	if (format === "LT") {
		return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
	}
	if (format === "LL") {
		return new Intl.DateTimeFormat(locale, { timeZone: timezone, year: "numeric", month: "long", day: "numeric" }).format(date);
	}
	return format
		.replaceAll("YYYY", parts.year)
		.replaceAll("MMMM", new Intl.DateTimeFormat(locale, { timeZone: timezone, month: "long" }).format(date))
		.replaceAll("MMM", new Intl.DateTimeFormat(locale, { timeZone: timezone, month: "short" }).format(date))
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
	state.writes.push({ name, value, operation: "set" });
};

const deleteVariable = (state: EvaluationState, name: string): void => {
	state.variables.delete(name);
	state.writes.push({ name, value: undefined, operation: "delete" });
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
	return output.replace(/(?:\r?\n)?__DITZY_TRIM_SENTINEL__(?:\r?\n)?/g, "").replace(/\\([{}])/g, "$1");
};

const evaluateCondition = (condition: string, state: EvaluationState, node: MacroNode): string => {
	const shorthand = condition.match(/^([.$])([A-Za-z](?:[\w-]*[\w])?)(?:\s*(\|\|=|\?\?=|\|\||\?\?|\+\+|--|\+=|-=|==|!=|>=|<=|>|<|=)\s*(.*))?$/s);
	if (shorthand !== null) {
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
		if (operator === "++") setVariable(state, name, (asNumber(current) ?? 0) + 1);
		if (operator === "--") setVariable(state, name, (asNumber(current) ?? 0) - 1);
		if (operator === "+=") {
			const left = asNumber(current);
			const right = asNumber(evaluated);
			setVariable(state, name, left !== undefined && right !== undefined ? left + right : `${current}${evaluated}`);
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
		return evaluateCondition(`${node.name}${node.args[0] ?? ""}`, state, node);
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
	if (["getvar", "varexists", "hasvar", "deletevar", "flushvar", "setvar", "addvar", "incvar", "decvar", "setlocalvar", "getlocalvar", "haslocalvar", "deletelocalvar"].includes(name)) {
		const variableName = args[0] ?? "";
		if (state.validationOnly) return "";
		if (name === "getvar" || name === "getlocalvar") return variable(state, variableName);
		if (name === "varexists" || name === "hasvar" || name === "haslocalvar") return String(state.variables.has(variableName));
		if (name === "deletevar" || name === "flushvar" || name === "deletelocalvar") {
			deleteVariable(state, variableName);
			return "";
		}
		if (name === "setvar" || name === "setlocalvar") {
			setVariable(state, variableName, args[1] ?? "");
			return "";
		}
		const current = asNumber(variable(state, variableName));
		if (name === "incvar" || name === "decvar") {
			const next = (current ?? 0) + (name === "incvar" ? 1 : -1);
			setVariable(state, variableName, next);
			return String(next);
		}
		setVariable(state, variableName, `${variable(state, variableName)}${args[1] ?? ""}`);
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
