/* eslint-disable anti-slop/no-unknown-parameters -- libfx hands the tool the model's arguments as unknown JSON, which the tools check before running. */
import type { Database } from "bun:sqlite";
import { TypeGuard, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createFxAgent, memory } from "libfx/node";
import type { QuickJSHandle } from "quickjs-emscripten-core";
import type { BoxId } from "../../shared/contract/box";
import { codeAgentRunInput, codeAgentSubmitInput } from "../../shared/contract/box-descriptor";
import { sandboxedFailure, type SandboxedFailure } from "../../shared/contract/box-sandboxed";
import { resolveBoxDelegate } from "./delegate-settings";
import { determinism, guestRuntime } from "./sandboxed";

/** @approved The steps one code-agent run may take: model requests and tool calls count against the same cap. */
export const CODE_AGENT_STEPS = 24;
/** @approved Each code-agent run's QuickJS heap: the most its WebAssembly memory may grow to. */
export const CODE_AGENT_HEAP_BYTES = 128 * 1024 * 1024;
/** @approved The guest time one `run` call may take. */
export const CODE_AGENT_CALL_MS = 2_000;
/** @approved What one `run` call may return to the model, with a notice when it cuts anything off. */
export const CODE_AGENT_OUTPUT_BYTES = 8 * 1024;
/** @approved What one `run` call may log before further lines are dropped, so the host copy stays bounded. */
const CODE_AGENT_LOG_BYTES = 1024 * 1024;

/** @approved A function a global may hold: the guest calls it with JSON (or nothing) and it returns JSON. */
export type CodeAgentFunction = (input: CodeAgentValue | undefined) => CodeAgentValue | undefined;
/** @approved A value a global may hold: JSON, or a function the guest calls with JSON, nested in objects and arrays. */
export type CodeAgentValue = null | boolean | number | string | readonly CodeAgentValue[] | { readonly [key: string]: CodeAgentValue } | CodeAgentFunction;
/** @approved One global the agent explores: a sentence about it, its TypeBox schema and its frozen value. */
export type CodeAgentGlobal = { readonly description: string; readonly schema: TSchema; readonly value: CodeAgentValue };
/** @approved One `run` the agent made, as the writer watches it: a one-line summary of the code, the code and what it returned. */
export type CodeAgentActivity = { readonly summary: string; readonly code: string; readonly output: string };
/** @approved What one `run` call answered: its reply to the model, and the failure that ends the run when the guest hit a limit. */
type CodeAgentRun = { readonly output: string; readonly failure?: Error };

/** @approved What one code-agent run is asked and handed: the Box whose model answers, its instructions, the frozen globals the code explores, the schema a draft must pass with the Box's own check, the run's cancellation, and the writer's window onto each `run`. */
export type CodeAgentCall<Draft extends TSchema = TSchema> = {
	readonly boxId: BoxId;
	readonly instructions: string;
	readonly globals: Readonly<Record<string, CodeAgentGlobal>>;
	readonly submitSchema: Draft;
	readonly verify: (draft: Static<Draft>) => string | undefined;
	readonly signal: AbortSignal;
	readonly onActivity: (activity: CodeAgentActivity) => void;
};

// @approved
//  The short `.d.ts` the `run` tool's description carries, printed from the
// globals' schemas. Only the kinds a built-in Box's own schemas use are
// printed; anything else reads as `unknown`, which is what the guest can
// tell the model about it.
const declarationOf = (schema: TSchema): string => {
	if (TypeGuard.IsUnion(schema)) return schema.anyOf.map(declarationOf).join(" | ");
	if (TypeGuard.IsLiteral(schema)) return JSON.stringify(schema.const);
	if (TypeGuard.IsString(schema)) return "string";
	if (TypeGuard.IsNumber(schema) || TypeGuard.IsInteger(schema)) return "number";
	if (TypeGuard.IsBoolean(schema)) return "boolean";
	if (TypeGuard.IsNull(schema)) return "null";
	if (TypeGuard.IsUndefined(schema)) return "undefined";
	if (TypeGuard.IsArray(schema)) return `${declarationOf(schema.items)}[]`;
	if (TypeGuard.IsTuple(schema)) return `[${schema.items.map(declarationOf).join(", ")}]`;
	if (TypeGuard.IsRecord(schema)) {
		const [recorded] = Object.values(schema.patternProperties);
		return `{ [key: string]: ${recorded === undefined ? "unknown" : declarationOf(recorded)} }`;
	}
	if (TypeGuard.IsObject(schema)) return `{ ${Object.entries(schema.properties).map(([key, property]) => `${TypeGuard.IsOptional(property) ? `${key}?` : key}: ${declarationOf(property)}`).join("; ")} }`;
	if (TypeGuard.IsFunction(schema)) {
		const names = schema.parameters.map((_, index) => schema.parameters.length === 1 ? "input" : `arg${index}`);
		return `(${schema.parameters.map((parameter, index) => `${names[index]}: ${declarationOf(parameter)}`).join(", ")}) => ${declarationOf(schema.returns)}`;
	}
	if (TypeGuard.IsIntersect(schema)) return schema.allOf.map(declarationOf).join(" & ");
	return "unknown";
};

/** @approved The `.d.ts` of the sandbox: each global declared from its schema, with the `console` the prelude provides. */
const declarations = (globals: Readonly<Record<string, CodeAgentGlobal>>) => [
	...Object.entries(globals).map(([name, global]) => `/** ${global.description} */\ndeclare const ${name}: ${declarationOf(global.schema)};`),
	"declare const console: { log(...values: unknown[]): void };",
].join("\n");

// @approved
//  The guest side of the run tool: `console.log` strings its arguments and
// hands one line to the host's capture, and `show` renders a value as JSON,
// capped at the output limit. `determinism` (sandboxed.ts) has already taken
// the clock and `Math.random`, so equal inputs give equal outcomes.
const prelude = `(log) => {
	const show = (value) => {
		try { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); } catch { return "a value that cannot be shown"; }
	};
	globalThis.console = { log: (...values) => log(values.length === 0 ? "undefined" : values.map(show).join(" ")) };
}`;

// @approved
//  The guest helpers the host calls with handles: `show` returns a run's
// final value as JSON (or why it cannot), capped at the output limit, and
// `freeze` freezes an injected global deeply, in place.
const helpers = `({
	show: (value, limit) => {
		if (value === undefined) return "undefined";
		let shown;
		try { shown = JSON.stringify(value); } catch { return "a value JSON cannot show; return a JSON value"; }
		if (shown === undefined) return "a value JSON cannot show; return a JSON value";
		return shown.length > limit ? shown.slice(0, limit) : shown;
	},
	freeze: (value) => {
		const freeze = (item) => {
			if (item !== null && (typeof item === "object" || typeof item === "function")) { Object.freeze(item); for (const key of Object.keys(item)) freeze(item[key]); }
			return item;
		};
		return freeze(value);
	},
})`;

const isFunction = (value: CodeAgentValue): value is CodeAgentFunction => typeof value === "function";
const isNumber = (value: CodeAgentValue): value is number => typeof value === "number";
const isText = (value: CodeAgentValue): value is string => typeof value === "string";

/** @approved A guest failure that ends the run: the limits, with their reasons; any other throw is the tool's output instead. */
const runFailure = (id: BoxId, { name, message }: SandboxedFailure): Error | undefined =>
	name === "InternalError" && message === "interrupted" ? new Error(`The ${id} Box's code ran past its ${CODE_AGENT_CALL_MS / 1000} s limit.`)
	: name === "InternalError" && message === "out of memory" ? new Error(`The ${id} Box's code ran out of its ${CODE_AGENT_HEAP_BYTES / 1024 / 1024} MiB heap.`)
	: undefined;

// @approved
//  The agent's QuickJS guest: one runtime and context for the whole run, on
// the sandboxed Boxes' module instance and memory cap, holding the frozen
// `globals` and a `console.log` that captures what the code logs. Each `run`
// call evaluates its code in the global scope under the deadline, so a
// variable set in one call is there in the next, and answers the logged
// lines and the code's final value as JSON, cut off at the output limit.
// Nothing host-side but the log capture is reachable: the wasmfile build has
// no network or filesystem, `determinism` removes the clock and
// `Math.random`, and the helpers the host calls are never named in the
// guest, so the only host function the code can reach is `console.log`.
const codeGuest = async (id: BoxId, globals: Readonly<Record<string, CodeAgentGlobal>>) => {
	const { runtime, enter } = await guestRuntime(CODE_AGENT_HEAP_BYTES, CODE_AGENT_CALL_MS);
	const vm = runtime.newContext();
	const kept: QuickJSHandle[] = [];
	const logs: string[] = [];
	let loggedBytes = 0;
	const dispose = () => {
		try {
			for (const handle of kept) handle.dispose();
			vm.dispose();
			runtime.dispose();
		} catch { /* @approved A trapped heap is reclaimed whole by the host GC. */ }
	};
	const failureOf = (handle: QuickJSHandle): SandboxedFailure => {
		try {
			const dumped: unknown = vm.dump(handle);
			return Value.Check(sandboxedFailure, dumped) ? dumped : { name: "Error", message: String(dumped) };
		} finally { handle.dispose(); }
	};
	const failed = (failure: SandboxedFailure): Error => runFailure(id, failure) ?? new Error(`The ${id} Box's code threw ${failure.name}: ${failure.message}.`);
	const evaluate = (code: string, file: string): QuickJSHandle => {
		enter();
		const result = vm.evalCode(code, file, { type: "global" });
		if (result.error !== undefined) throw failed(failureOf(result.error));
		return result.value!; // @approved A call result holds a value exactly when it holds no error.
	};
	const call = (fn: QuickJSHandle, ...args: readonly QuickJSHandle[]): QuickJSHandle => {
		const result = vm.callFunction(fn, vm.undefined, ...args);
		if (result.error !== undefined) throw failed(failureOf(result.error));
		return result.value!; // @approved A call result holds a value exactly when it holds no error.
	};
	// @approved
	//  One global's value as guest handles: JSON leaves become guest values,
	// and a function leaf becomes a host function the guest calls with JSON it
	// dumps in and builds out again, so a call crosses as JSON alone.
	const build = (value: CodeAgentValue, name: string): QuickJSHandle => {
		if (isFunction(value)) return vm.newFunction(name, (input) => {
			const answer = value(input === undefined ? undefined : vm.dump(input));
			return answer === undefined ? vm.undefined : build(answer, name);
		});
		if (value === null) return vm.null;
		if (isNumber(value)) return vm.newNumber(value);
		if (isText(value)) return vm.newString(value);
		if (Array.isArray(value)) {
			const array = vm.newArray();
			for (const [index, item] of value.entries()) {
				const handle = build(item, `${name}[${index}]`);
				vm.setProp(array, index, handle);
				handle.dispose();
			}
			return array;
		}
		if (value === true || value === false) return value ? vm.true : vm.false;
		const object = vm.newObject();
		for (const [key, item] of Object.entries(value)) {
			const handle = build(item, `${name}.${key}`);
			vm.setProp(object, key, handle);
			handle.dispose();
		}
		return object;
	};
	const cut = (text: string): string =>
		text.length > CODE_AGENT_OUTPUT_BYTES ? `${text.slice(0, CODE_AGENT_OUTPUT_BYTES)}\n\n[Output cut off at ${CODE_AGENT_OUTPUT_BYTES / 1024} KiB; narrow your query]` : text;
	// @approved
	//  One `run` call: the code evaluates in the global scope under one
	// deadline, and the reply is the logged lines and the final value, or why
	// the code stopped. The heap and time limits end the run; a guest throw is
	// the call's output, so the model can fix its code and go on.
	const run = (code: string): CodeAgentRun => {
		logs.length = 0;
		loggedBytes = 0;
		const logged = () => logs.length === 0 ? "" : `Logged:\n${logs.join("\n")}\n\n`;
		try {
			enter();
			const result = vm.evalCode(code, "run.js", { type: "global" });
			if (result.error !== undefined) {
				const failure = failureOf(result.error);
				const limited = runFailure(id, failure);
				return limited === undefined ? { output: cut(`${logged()}The code threw ${failure.name}: ${failure.message}`) } : { output: limited.message, failure: limited };
			}
			const value = result.value!; // @approved A call result holds a value exactly when it holds no error.
			try {
				const shown = call(show, value, limit);
				const reply = vm.getString(shown);
				shown.dispose();
				return { output: cut(`${logged()}Returned:\n${reply}`) };
			} finally { value.dispose(); }
		} catch (error) {
			if (!(error instanceof WebAssembly.RuntimeError)) throw error;
			const trapped = new Error(`The ${id} Box's code threw ${error.name}: ${error.message}.`);
			return { output: trapped.message, failure: trapped };
		}
	};
	let show: QuickJSHandle;
	let limit: QuickJSHandle;
	try {
		evaluate(determinism, "determinism.js").dispose();
		const capture = vm.newFunction("log", (text) => {
			const length = vm.getProp(text, "length");
			const units = vm.getNumber(length);
			length.dispose();
			if (loggedBytes >= CODE_AGENT_LOG_BYTES || units > CODE_AGENT_LOG_BYTES) return;
			const line = vm.getString(text);
			logs.push(line);
			loggedBytes += line.length;
		});
		kept.push(capture);
		const preludeFn = evaluate(prelude, "prelude.js");
		const installed = call(preludeFn, capture);
		preludeFn.dispose();
		installed.dispose();
		const helperObject = evaluate(helpers, "helpers.js");
		show = vm.getProp(helperObject, "show");
		const freeze = vm.getProp(helperObject, "freeze");
		helperObject.dispose();
		kept.push(show, freeze);
		limit = vm.newNumber(CODE_AGENT_OUTPUT_BYTES);
		kept.push(limit);
		for (const [name, global] of Object.entries(globals)) {
			const handle = build(global.value, name);
			const frozen = call(freeze, handle);
			frozen.dispose();
			vm.setProp(vm.global, name, handle);
			handle.dispose();
		}
	} catch (error) {
		dispose();
		throw error;
	}
	return { run, dispose };
};

// @approved
//  One code-agent run: a libfx agent on the Box's delegate setting, built
// for this run and closed with it, whose two tools work one QuickJS context
// the run owns and disposes however it ends. `run` explores the frozen
// globals; `submit` checks the draft against `submitSchema`, then the Box's
// own `verify`, and either refusal goes back to the model as a tool error,
// so the first valid draft ends the run and is its result. A model request
// and a tool call count against the same step cap, the run's signal cancels
// the turn and its fetches, and a run that ends, fails or is cancelled
// leaves no QuickJS context behind.
export const runCodeAgent = async <Draft extends TSchema>(database: Database, { boxId, instructions, globals, submitSchema, verify, signal, onActivity }: CodeAgentCall<Draft>): Promise<Static<Draft>> => {
	const setting = resolveBoxDelegate(database, boxId);
	if (setting.kind !== "ready") throw new Error(setting.kind === "broken" ? setting.reason : `The ${boxId} Box's agent is off; choose its model in Connection Settings.`);
	signal.throwIfAborted();
	const guest = await codeGuest(boxId, globals);
	const submitInput = codeAgentSubmitInput(submitSchema);
	const runInput = codeAgentRunInput;
	const turn = new AbortController();
	const aborted = AbortSignal.any([signal, turn.signal]);
	let failure: string | undefined;
	let refusal: string | undefined;
	let submitted: Static<Draft> | undefined;
	let steps = 0;
	const stop = (reason: string) => {
		failure ??= reason;
		turn.abort();
	};
	const fail = (reason: string): never => {
		stop(reason);
		throw new Error(reason);
	};
	const over = () => {
		steps += 1;
		return steps > CODE_AGENT_STEPS;
	};
	const limit = `The agent passed its ${CODE_AGENT_STEPS}-step limit.`;
	const summarized = (code: string) => {
		const line = code.replaceAll(/\s+/g, " ").trim();
		return line.length > 80 ? `${line.slice(0, 80)}…` : line;
	};
	const agent = createFxAgent({
		backend: "wasm", durability: memory(), name: "code-agent", instructions,
		tools: [{
			name: "run", idempotent: false, writes: true,
			description: [
				`Runs JavaScript in a sandbox and returns what console.log printed and the code's final value as JSON, cut off at ${CODE_AGENT_OUTPUT_BYTES / 1024} KiB.`,
				"One context lasts the whole run, so a variable set in one call is there in the next. There is no network, filesystem, clock or randomness.",
				"The code sees only:",
				"",
				declarations(globals),
			].join("\n"),
			inputSchema: JSON.parse(JSON.stringify(runInput)),
			execute: (proposed: unknown) => {
				if (!Value.Check(runInput, proposed)) {
					const error = Value.Errors(runInput, proposed).First();
					return { type: "libfx.tool-result", text: `The run call is invalid${error === undefined ? "" : ` at ${error.path || "/"}: ${error.message}`}.`, images: [], isError: true };
				}
				let outcome: CodeAgentRun;
				try {
					outcome = guest.run(proposed.code);
				} catch (error) {
					const failure = error instanceof Error ? error : new Error(String(error));
					outcome = { output: failure.message, failure };
				}
				onActivity({ summary: summarized(proposed.code), code: proposed.code, output: outcome.output });
				if (outcome.failure !== undefined) fail(outcome.failure.message);
				return outcome.output;
			},
		}, {
			name: "submit", idempotent: false, writes: true,
			description: "Submits the run's result and ends the run. The draft is checked against its schema and the Box's own rules; either refusal comes back with its reason, and the first valid draft is the run's result.",
			inputSchema: JSON.parse(JSON.stringify(submitInput)),
			execute: (proposed: unknown) => {
				if (submitted !== undefined) fail("The agent called submit after its draft was accepted.");
				if (Value.Check(submitInput, proposed)) {
					let reason: string | undefined;
					try {
						reason = verify(proposed.draft);
					} catch (error) {
						fail(`The ${boxId} Box's verify threw ${error instanceof Error ? error.message : String(error)}.`);
					}
					if (reason !== undefined) {
						refusal = `The draft was refused: ${reason}`;
						return { type: "libfx.tool-result", text: refusal, images: [], isError: true };
					}
					submitted = proposed.draft;
					turn.abort();
					return "Submitted; the run is complete.";
				}
				const error = Value.Errors(submitInput, proposed).First();
				refusal = `The draft is invalid${error === undefined ? "" : ` at ${error.path || "/"}: ${error.message}`}.`;
				return { type: "libfx.tool-result", text: refusal, images: [], isError: true };
			},
		}],
		// @approved
		//  Every tool call the model makes is a step, a call to a tool the agent
		// does not have included, which libfx refuses before any tool runs, so
		// the steps are counted where libfx reports each call starting.
		hooks: { onEvent: (event) => { if (event.type === "tool.start" && !event.data.rerun && over()) stop(limit); } },
		...setting.options,
		fetch: async (input: string, init: RequestInit) => {
			if (over()) fail(limit);
			return await setting.options.fetch(input, { ...init, signal: init.signal === undefined || init.signal === null ? aborted : AbortSignal.any([init.signal, aborted]) });
		},
	});
	try {
		const result = await agent.session().prompt("Begin.", { signal: aborted }).result.catch((error: unknown) => ({ stopReason: "error" as const, error: { message: error instanceof Error ? error.message : String(error) } }));
		signal.throwIfAborted();
		if (submitted !== undefined) return submitted;
		if (failure !== undefined) throw new Error(failure);
		if (result.stopReason === "error") throw new Error(`The agent's model request failed: ${result.error?.message ?? "no reason given"}`);
		throw new Error(refusal ?? "The agent ended without submitting a draft.");
	} finally {
		guest.dispose();
		await agent.close().catch(() => undefined);
	}
};
