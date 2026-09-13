import type { MacroArgument, MacroNode, MacroDocumentNode } from "./prompt-macro-syntax";
import { sliceMacroDocument } from "./prompt-macro-syntax";
import type { MacroAttemptState, MacroEnvironment } from "./prompt-macro-engine";
import type { PromptWarning } from "./contract/conversation-schema";
import { isMacroVariableName, type MacroValue, type MacroVariableWrite } from "./contract/macro-variables";

export interface MacroDispatchContext {
	readonly source: string;
	readonly environment: MacroEnvironment;
	readonly attemptState: MacroAttemptState;
	readonly writes: MacroVariableWrite[];
	readonly warnings: PromptWarning[];
	readonly blockLabel: string;
	readonly validationOnly: boolean;
	readonly evaluate: (nodes: readonly MacroDocumentNode[]) => string;
}

type MacroHandler = (node: MacroNode, args: readonly string[], context: MacroDispatchContext) => string;
type VariableOperation = "read" | "exists" | "delete" | "set" | "add" | "increment" | "decrement";

interface MacroDefinition {
	handler: MacroHandler;
	readonly volatile?: boolean;
	readonly validate?: MacroHandler;
	readonly evaluateArgs?: boolean;
}

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

const nodeSource = (node: MacroDocumentNode): string => node.kind === "text" ? node.text : node.raw;
const nodesSource = (nodes: readonly MacroDocumentNode[]): string => nodes.map(nodeSource).join("");

const normalizeScopeNodes = (nodes: readonly MacroDocumentNode[], preserve: boolean): readonly MacroDocumentNode[] => {
	if (preserve) return nodes;
	const source = nodesSource(nodes);
	const minimum = Math.min(...source.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0), Infinity);
	const normalized: MacroDocumentNode[] = [];
	let lineStart = true;
	for (const node of nodes) {
		if (node.kind === "macro") {
			normalized.push(node);
			lineStart = false;
			continue;
		}
		let text = "";
		let indent = 0;
		for (const character of node.text) {
			if (lineStart && indent < (Number.isFinite(minimum) ? minimum : 0) && (character === " " || character === "\t")) {
				indent += 1;
				continue;
			}
			text += character;
			if (character === "\n") {
				lineStart = true;
				indent = 0;
			} else lineStart = false;
		}
		if (text !== "") normalized.push({ ...node, text });
	}
	while (normalized[0]?.kind === "text" && normalized[0].text.length > 0) {
		const first = normalized[0];
		if (first.kind !== "text") break;
		const text = first.text.replace(/^\s+/, "");
		if (text === first.text) break;
		if (text === "") normalized.shift();
		else normalized[0] = { ...first, text };
	}
	while (true) {
		const last = normalized.at(-1);
		if (last?.kind !== "text" || last.text.length === 0) break;
		const text = last.text.replace(/\s+$/, "");
		if (text === last.text) break;
		if (text === "") normalized.pop();
		else normalized[normalized.length - 1] = { ...last, text };
	}
	return normalized;
};

const scopedContent = (nodes: readonly MacroDocumentNode[], preserve: boolean): string =>
	nodesSource(normalizeScopeNodes(nodes, preserve));

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
	if (format === "LT") return new Intl.DateTimeFormat(locale, { timeZone: target.intlTimeZone, hour: "numeric", minute: "2-digit" }).format(target.date);
	if (format === "LL") return new Intl.DateTimeFormat(locale, { timeZone: target.intlTimeZone, year: "numeric", month: "long", day: "numeric" }).format(target.date);
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

const warn = (context: MacroDispatchContext, node: MacroNode): void => {
	context.warnings.push({ block: context.blockLabel, macro: node.raw });
};

const failure = (node: MacroNode, context: MacroDispatchContext, keepLiteralDuringValidation = false): string => {
	warn(context, node);
	return context.validationOnly && !keepLiteralDuringValidation ? "" : node.raw;
};

const variable = (context: MacroDispatchContext, name: string): string => normalize(context.attemptState.variables.get(name));

const setVariable = (context: MacroDispatchContext, name: string, value: MacroValue): void => {
	context.attemptState.variables.set(name, value);
	if (!context.validationOnly) {
		const write = { name, value, operation: "set" } as const;
		context.writes.push(write);
		context.attemptState.writes.push(write);
	}
};

const deleteVariable = (context: MacroDispatchContext, name: string): void => {
	context.attemptState.variables.delete(name);
	if (!context.validationOnly) {
		const write = { name, value: undefined, operation: "delete" } as const;
		context.writes.push(write);
		context.attemptState.writes.push(write);
	}
};

const addVariable = (context: MacroDispatchContext, name: string, addition: string | number): string => {
	const currentValue = context.attemptState.variables.get(name);
	if (Array.isArray(currentValue)) {
		setVariable(context, name, [...currentValue, addition]);
		return variable(context, name);
	}
	const current = asNumber(currentValue === undefined ? "" : normalize(currentValue));
	const amount = asNumber(addition);
	setVariable(
		context,
		name,
		current !== undefined && amount !== undefined ? current + amount : `${variable(context, name)}${addition}`,
	);
	return variable(context, name);
};

const requiredArgument = (node: MacroNode, args: readonly string[], context: MacroDispatchContext): string | undefined => {
	if (args.length === 0 || (args.length === 1 && args[0] === "")) {
		failure(node, context);
		return undefined;
	}
	return args[0];
};

const listChoices = (node: MacroNode, args: readonly string[], context: MacroDispatchContext): string[] | undefined => {
	if (args.length === 0) {
		failure(node, context);
		return undefined;
	}
	const choices = listArguments(args);
	if (choices.length === 1 && choices[0] === "") {
		failure(node, context);
		return undefined;
	}
	return choices;
};

const evaluateCondition = (condition: MacroArgument | undefined, node: MacroNode, context: MacroDispatchContext): string | undefined => {
	if (condition === undefined) return undefined;
	const raw = condition.raw.trim();
	const shorthand = raw.match(/^([.$])([A-Za-z](?:[\w-]*[\w])?)(?:\s*(\|\|=|\?\?=|\|\||\?\?|\+\+|--|\+=|-=|==|!=|>=|<=|>|<|=)\s*(.*))?$/s);
	if (shorthand !== null) {
		if (shorthand[1] === "$") {
			warn(context, node);
			return undefined;
		}
		const name = shorthand[2];
		const operator = shorthand[3];
		const rhs = shorthand[4] ?? "";
		const current = variable(context, name);
		const trimmedStart = condition.raw.indexOf(raw);
		const rhsStart = rhs === "" ? condition.end : condition.start + trimmedStart + raw.length - rhs.length;
		const rhsNodes = rhs === "" ? [] : sliceMacroDocument(condition.nodes, rhsStart, condition.end, context.source);
		const evaluateRhs = (): string => context.evaluate(rhsNodes);
		if (operator === undefined) return current;
		if (context.validationOnly) {
			evaluateRhs();
			return "";
		}
		if (operator === "==" || operator === "!=") return String(operator === "==" ? current === evaluateRhs() : current !== evaluateRhs());
		if ([">", ">=", "<", "<="].includes(operator)) {
			const left = asNumber(current);
			const right = asNumber(evaluateRhs());
			if (left === undefined || right === undefined) return "false";
			return String(operator === ">" ? left > right : operator === ">=" ? left >= right : operator === "<" ? left < right : left <= right);
		}
		if (operator === "||") return falsy(current) ? evaluateRhs() : current;
		if (operator === "??") return context.attemptState.variables.has(name) ? current : evaluateRhs();
		if (operator === "||=") {
			if (falsy(current)) setVariable(context, name, evaluateRhs());
			return variable(context, name);
		}
		if (operator === "??=") {
			if (!context.attemptState.variables.has(name)) setVariable(context, name, evaluateRhs());
			return variable(context, name);
		}
		const evaluated = evaluateRhs();
		if (operator === "=") {
			setVariable(context, name, evaluated);
			return "";
		}
		if (operator === "++") return addVariable(context, name, 1);
		if (operator === "--") return addVariable(context, name, -1);
		if (operator === "+=") {
			addVariable(context, name, evaluated);
			return "";
		}
		if (operator === "-=") {
			const left = asNumber(current);
			const right = asNumber(evaluated);
			if (left === undefined || right === undefined) {
				warn(context, node);
				return "";
			}
			setVariable(context, name, left - right);
			return "";
		}
		return variable(context, name);
	}
	return context.evaluate(condition.nodes);
};

const splitElse = (nodes: readonly MacroDocumentNode[]): [readonly MacroDocumentNode[], readonly MacroDocumentNode[] | undefined] => {
	const index = nodes.findIndex((node) => node.kind === "macro" && node.name.toLowerCase() === "else");
	if (index === -1) return [nodes, undefined];
	return [nodes.slice(0, index), nodes.slice(index + 1)];
};

const variableHandler = (node: MacroNode, args: readonly string[], context: MacroDispatchContext, operation: VariableOperation): string => {
	const name = args[0] ?? "";
	if (!isMacroVariableName(name)) {
		return failure(node, context, true);
	}
	if (context.validationOnly) return "";
	if (operation === "read") return variable(context, name);
	if (operation === "exists") return String(context.attemptState.variables.has(name));
	if (operation === "delete") {
		deleteVariable(context, name);
		return "";
	}
	if (operation === "set") {
		setVariable(context, name, args[1] ?? "");
		return "";
	}
	if (operation === "increment" || operation === "decrement") return addVariable(context, name, operation === "increment" ? 1 : -1);
	addVariable(context, name, args[1] ?? "");
	return "";
};

const variableAliases = {
	read: ["getvar", "getlocalvar"],
	exists: ["varexists", "hasvar", "haslocalvar"],
	delete: ["deletevar", "flushvar", "deletelocalvar", "flushlocalvar"],
	set: ["setvar", "setlocalvar"],
	add: ["addvar", "addlocalvar"],
	increment: ["incvar", "inclocalvar"],
	decrement: ["decvar", "declocalvar"],
} as const satisfies Record<VariableOperation, readonly string[]>;

const variableDefinition = (operation: VariableOperation): MacroDefinition => ({
	handler: (node, args, context) => variableHandler(node, args, context, operation),
});

const requiredArgumentValidation: MacroHandler = (node, args, context) => {
	requiredArgument(node, args, context);
	return "";
};

const diceValidation: MacroHandler = (node, args, context) => {
	const formula = requiredArgument(node, args, context);
	if (formula !== undefined && !isDiceFormula(formula)) failure(node, context);
	return "";
};

const macroDefinitions: ReadonlyMap<string, MacroDefinition> = new Map([
	["self", { handler: (_node, _args, context) => context.environment.self }],
	["other", { handler: (_node, _args, context) => context.environment.other }],
	["space", { handler: (_node, args) => " ".repeat(Math.max(0, Math.trunc(Number(args[0] ?? 1) || 0))) }],
	["newline", { handler: (_node, args) => "\n".repeat(Math.max(0, Math.trunc(Number(args[0] ?? 1) || 0))) }],
	["noop", { handler: () => "" }],
	["trim", { handler: (node, _args) => node.scope === undefined ? "" : scopedContent(node.scope, node.flags.includes("#")).trim() }],
	["reverse", { handler: (node, args) => Array.from(node.scope === undefined ? args[0] ?? "" : scopedContent(node.scope, node.flags.includes("#"))).reverse().join("") }],
	["random", { volatile: true, validate: requiredArgumentValidation, handler: (node, args, context) => {
		const choices = listChoices(node, args, context);
		if (choices === undefined) return context.validationOnly ? "" : node.raw;
		return choices[Math.floor(randomFloat(context.environment) * choices.length)] ?? "";
	} }],
	["pick", { volatile: true, validate: requiredArgumentValidation, handler: (node, args, context) => {
		const choices = listChoices(node, args, context);
		if (choices === undefined) return context.validationOnly ? "" : node.raw;
		const identity = `${context.environment.conversationId ?? ""}|${context.environment.promptPresetId ?? ""}|${context.attemptState.macroPositionBase}|${node.raw}|${node.start}`;
		return choices[hash(identity) % choices.length] ?? "";
	} }],
	["roll", { volatile: true, validate: diceValidation, handler: (node, args, context) => {
		const formula = args[0] ?? "";
		if (!isDiceFormula(formula)) {
			return failure(node, context);
		}
		return dice(formula, context.environment);
	} }],
	["time", { volatile: true, handler: (_node, args, context) => formatDate(context.environment.now ?? new Date(0), "LT", context.environment, args[0]) }],
	["date", { volatile: true, handler: (_node, args, context) => formatDate(context.environment.now ?? new Date(0), "LL", context.environment, args[0]) }],
	["weekday", { volatile: true, handler: (_node, args, context) => dateParts(context.environment.now ?? new Date(0), timezoneOf(args[0], timezoneOf(context.environment.timeZone, "UTC")), localeOf(context.environment.locale)).weekday }],
	["isotime", { volatile: true, handler: (_node, args, context) => formatDate(context.environment.now ?? new Date(0), "HH:mm", context.environment, args[0]) }],
	["isodate", { volatile: true, handler: (_node, args, context) => formatDate(context.environment.now ?? new Date(0), "YYYY-MM-DD", context.environment, args[0]) }],
	["datetimeformat", { volatile: true, handler: (_node, args, context) => formatDate(context.environment.now ?? new Date(0), args[0] ?? "", context.environment, args[1]) }],
	["timediff", { volatile: true, handler: (node, args, context) => {
		const then = Date.parse(args[0] ?? "");
		if (Number.isNaN(then)) return "";
		return humanizeDuration((context.environment.now ?? new Date(0)).getTime() - then);
	} }],
	["if", { evaluateArgs: false, handler: (node, _args, context) => {
		const condition = evaluateCondition(node.args[0], node, context);
		const content = node.scope ?? node.args[1]?.nodes ?? [];
		const normalizedContent = normalizeScopeNodes(content, node.flags.includes("#"));
		const [whenTrue, whenFalseFromScope] = splitElse(normalizedContent);
		const whenFalse = node.scope === undefined ? node.args[2]?.nodes : whenFalseFromScope;
		if (context.validationOnly) {
			context.evaluate(whenTrue);
			context.evaluate(whenFalse ?? []);
			return "";
		}
		if (condition === undefined) return node.raw;
		const useTrue = node.flags.includes("!") ? falsy(condition) : !falsy(condition);
		return context.evaluate((useTrue ? whenTrue : whenFalse) ?? []);
	} }],
	["//", { evaluateArgs: false, handler: () => "" }],
	["comment", { evaluateArgs: false, handler: () => "" }],
	// ==[HUMAN APPROVED]== SAFETY: Object.entries supplies only the literal variable alias keys above;
	// each key is narrowed to the VariableOperation accepted by variableDefinition.
	...Object.entries(variableAliases).flatMap(([operation, names]) => names.map((name) => [name, variableDefinition(operation as VariableOperation)] as const)),
]);

const unknownMacro = (node: MacroNode, args: readonly string[], context: MacroDispatchContext): string => {
	warn(context, node);
	if (args.length === 0 && node.scope === undefined) return node.raw;
	const argumentText = args.length === 0 ? "" : `::${args.join("::")}`;
	const scopeContent = node.scope === undefined ? "" : context.validationOnly ? context.evaluate(node.scope) : nodesSource(node.scope);
	const scopedText = node.scope === undefined ? "" : `${scopeContent}{{/${node.name}}}`;
	return `{{${node.name}${argumentText}}}${scopedText}`;
};

const shorthandDefinition: MacroDefinition = {
	evaluateArgs: false,
	handler: (node, _args, context) => evaluateCondition({
		nodes: node.args[0]?.nodes ?? [],
		raw: `${node.name}${node.args[0]?.raw ?? ""}`,
		start: node.start + 2,
		end: node.args[0]?.end ?? node.end,
	}, node, context) ?? node.raw,
};

export const dispatchMacro = (node: MacroNode, context: MacroDispatchContext): string => {
	if (node.name.startsWith("$")) return unknownMacro(node, [], context);
	const definition = node.name.startsWith(".") ? shorthandDefinition : macroDefinitions.get(node.name.toLowerCase());
	if (definition === undefined) {
		const args = node.args.map((arg) => context.evaluate(arg.nodes).trim());
		return unknownMacro(node, args, context);
	}
	const args = definition.evaluateArgs === false ? [] : node.args.map((arg) => context.evaluate(arg.nodes).trim());
	if (context.validationOnly && definition.volatile) return definition.validate?.(node, args, context) ?? "";
	return definition.handler(node, args, context);
};
