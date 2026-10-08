import type { PromptWarning } from "./contract/conversation-schema";
import { type MacroValue, type MacroVariableWrite } from "./contract/macro-variables";
import { dispatchMacro, type MacroDispatchContext } from "./prompt-macro-dispatch";
import { parseMacroDocument, unescapeMacroText, type MacroDocumentNode } from "./prompt-macro-syntax";

export type { MacroValue, MacroVariableWrite } from "./contract/macro-variables";

// @approved
//  Immutable inputs for one attempt. The evaluator never reads browser
// globals, a database, or the wall clock. Mutable values live in the explicit
// MacroAttemptState passed alongside this environment.

export interface MacroEnvironment {
	readonly self: string;
	readonly other: string;
	readonly conversationId?: string | number;
	readonly promptPresetId?: string | number;
	readonly now?: Date;
	readonly timeZone?: string;
	readonly locale?: string;
	readonly random?: () => number;
}

// @approved
//  Mutable state for one complete attempt. Evaluation receives this as a
// visible parameter rather than inheriting it from a shared environment record;
// authored blocks therefore observe writes in order and budget recompilation
// can reuse the same expansion cache without losing the attempt journal.
export interface MacroAttemptState {
	readonly variables: Map<string, MacroValue>;
	readonly writes: MacroVariableWrite[];
	readonly expansionCache: Map<string, MacroExpansionResult>;
	macroPositionBase: string | number;
}

export interface AttemptEnvironmentInput {
	readonly self: string;
	readonly other: string;
	readonly conversationId: string | number;
	readonly promptPresetId: string | number;
	readonly now: Date;
	readonly timeZone?: string;
	readonly locale?: string;
	readonly variables?: ReadonlyMap<string, MacroValue>;
	readonly random?: () => number;
}

export interface AttemptEnvironment {
	readonly environment: MacroEnvironment;
	readonly state: MacroAttemptState;
}

export const createMacroAttemptState = (
	variables: ReadonlyMap<string, MacroValue> = new Map(),
): MacroAttemptState => ({
	variables: new Map(variables),
	writes: [],
	expansionCache: new Map(),
	macroPositionBase: "",
});

// @approved
//  One named construction path captures every immutable input and creates
// every mutable per-attempt value. Generation capture and creation-time
// opening expansion therefore cannot forget the journal or cache.
export const createAttemptEnvironment = (input: AttemptEnvironmentInput): AttemptEnvironment => ({
	environment: {
		self: input.self,
		other: input.other,
		conversationId: input.conversationId,
		promptPresetId: input.promptPresetId,
		now: input.now,
		timeZone: input.timeZone,
		locale: input.locale,
		random: input.random ?? Math.random,
	},
	state: createMacroAttemptState(input.variables),
});

export interface MacroExpansionResult {
	readonly text: string;
	readonly warnings: readonly PromptWarning[];
	readonly writes: readonly MacroVariableWrite[];
}

export interface MacroValidationResult {
	readonly warnings: readonly PromptWarning[];
}

const evaluateNodes = (nodes: readonly MacroDocumentNode[], context: Omit<MacroDispatchContext, "evaluate">): string => {
	let output = "";
	let trimNextLine = false;
	const append = (value: string): void => {
		let next = unescapeMacroText(value);
		if (trimNextLine) {
			next = next.replace(/^\r?\n/, "");
			trimNextLine = false;
		}
		output += next;
	};
	for (const node of nodes) {
		if (node.kind === "text") {
			append(node.text);
			continue;
		}
		if (node.name.toLowerCase() === "trim" && node.scope === undefined) {
			output = output.replace(/\r?\n$/, "");
			trimNextLine = true;
			continue;
		}
		append(dispatchMacro(node, {
			...context,
			evaluate: (nested) => evaluateNodes(nested, context),
		}));
	}
	return output;
};

export const expandMacroText = (
	source: string,
	environment: MacroEnvironment,
	attemptState: MacroAttemptState,
	blockLabel: string,
	options: { validationOnly?: boolean } = {},
): MacroExpansionResult => {
	const context: Omit<MacroDispatchContext, "evaluate"> = {
		source,
		environment,
		attemptState,
		writes: [],
		warnings: [],
		blockLabel,
		validationOnly: options.validationOnly === true,
	};
	const nodes = parseMacroDocument(source);
	return {
		text: evaluateNodes(nodes, context),
		warnings: context.warnings,
		writes: context.writes,
	};
};

export const validateMacroText = (source: string, blockLabel: string): MacroValidationResult => ({
	warnings: expandMacroText(
		source,
		{ self: "", other: "" },
		{ ...createMacroAttemptState(), macroPositionBase: "validation" },
		blockLabel,
		{ validationOnly: true },
	).warnings,
});
