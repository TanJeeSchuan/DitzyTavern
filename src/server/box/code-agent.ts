/* eslint-disable anti-slop/no-unknown-parameters -- libfx hands the tool the model's arguments as unknown JSON, which the tools check before running. */
import type { Database } from "bun:sqlite";
import { TypeGuard, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createFxAgent, memory } from "libfx/node";
import type { QuickJSHandle } from "quickjs-emscripten-core";
import { DEFAULT_BOX_DELEGATE, type BoxId } from "../../shared/contract/box";
import { codeAgentRunInput, codeAgentSubmitInput, type CodeAgentActivity } from "../../shared/contract/code-agent";
import { sandboxedFailure, type SandboxedFailure } from "../../shared/contract/box-sandboxed";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { resolveBoxDelegate } from "./delegate-settings";
import { determinism, guestError, guestLimit, guestRuntime, type GuestLimits } from "./sandboxed";

/** @approved The steps one code-agent run may take: model requests and tool calls count against the same cap. */
export const CODE_AGENT_STEPS = 24;
/** @approved Each code-agent run's QuickJS heap: the most its WebAssembly memory may grow to. */
const CODE_AGENT_HEAP_BYTES = 128 * 1024 * 1024;
/** @approved The guest time one `run` call may take. */
const CODE_AGENT_CALL_MS = 2_000;
/** @approved What one `run` call may return to the model, notice included, cut by its UTF-8 bytes. */
export const CODE_AGENT_OUTPUT_BYTES = 8 * 1024;

/** @approved The limits that stop the agent's code, as its failures are worded. */
const CODE_AGENT_LIMITS: GuestLimits = { ms: CODE_AGENT_CALL_MS, heapBytes: CODE_AGENT_HEAP_BYTES };
/** @approved The notice a cut-off reply ends with, inside the byte limit rather than past it. */
const OUTPUT_NOTE = "\n[Output cut off at 8 KiB; narrow your query]";

/** @approved A function a global may hold. It accepts up to one JSON input and returns a value for the guest. */
export type CodeAgentFunction = (input: GenerationJsonValue | undefined) => CodeAgentValue | undefined;
/** @approved A value a global may hold: JSON, or a function the guest calls with JSON, nested in objects and arrays. */
export type CodeAgentValue = null | boolean | number | string | readonly CodeAgentValue[] | { readonly [key: string]: CodeAgentValue } | CodeAgentFunction;
/** @approved One global the agent explores: a sentence about it, its TypeBox schema and its frozen value. */
export type CodeAgentGlobal = { readonly description: string; readonly schema: TSchema; readonly value: CodeAgentValue };
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
//  One `run` call's reply, cut at the byte limit with the notice inside it.
//  UTF-8 never encodes a character as a shorter prefix of another, so a cut
//  never passes the limit, and the replacement characters a partial one
//  leaves at its end are dropped.
const fit = (text: string): string => {
	if (Buffer.byteLength(text) <= CODE_AGENT_OUTPUT_BYTES) return text;
	const cut = Buffer.byteLength(OUTPUT_NOTE);
	return Buffer.from(text).subarray(0, CODE_AGENT_OUTPUT_BYTES - cut).toString("utf8").replace(/\uFFFD+$/, "") + OUTPUT_NOTE;
};

// @approved
//  The short `.d.ts` the agent's instructions carry, printed from the
// globals' schemas. Only the kinds a built-in Box's own schemas use are
// printed; anything else reads as `unknown`, which is what the guest can
// tell the model about it.
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// @approved
//  A property key the way a declaration needs it: identifiers stand as
// written, and any other name, such as a Box's hyphenated id, is quoted.
const keyOf = (key: string): string => identifier.test(key) ? key : JSON.stringify(key);
const propertyOf = ([key, property]: readonly [string, TSchema]): string =>
	`${TypeGuard.IsOptional(property) ? `${keyOf(key)}?` : keyOf(key)}: ${declarationOf(property)}`;
const declarationOf = (schema: TSchema): string => {
	if (TypeGuard.IsUnion(schema)) return schema.anyOf.map(declarationOf).join(" | ");
	if (TypeGuard.IsLiteral(schema)) return JSON.stringify(schema.const);
	if (TypeGuard.IsString(schema)) return "string";
	if (TypeGuard.IsNumber(schema) || TypeGuard.IsInteger(schema)) return "number";
	if (TypeGuard.IsBoolean(schema)) return "boolean";
	if (TypeGuard.IsNull(schema)) return "null";
	if (TypeGuard.IsUndefined(schema)) return "undefined";
	// @approved
	//  A union, intersection or function element needs its parentheses, so
	// `string | null[]` never stands for an array of `string | null`.
	if (TypeGuard.IsArray(schema)) {
		const element = declarationOf(schema.items);
		const grouped = TypeGuard.IsUnion(schema.items) || TypeGuard.IsIntersect(schema.items) || TypeGuard.IsFunction(schema.items);
		return `${grouped ? `(${element})` : element}[]`;
	}
	if (TypeGuard.IsTuple(schema)) return `[${(schema.items ?? []).map(declarationOf).join(", ")}]`;
	if (TypeGuard.IsRecord(schema)) {
		const [recorded] = Object.values(schema.patternProperties);
		return `{ [key: string]: ${recorded === undefined ? "unknown" : declarationOf(recorded)} }`;
	}
	if (TypeGuard.IsObject(schema)) return `{ ${Object.entries(schema.properties).map(propertyOf).join("; ")} }`;
	if (TypeGuard.IsFunction(schema)) {
		if (schema.parameters.length > 1) throw new Error("A code agent function global requires a schema with at most one JSON input.");
		const [input] = schema.parameters;
		return `(${input === undefined ? "" : `input: ${declarationOf(input)}`}) => ${declarationOf(schema.returns)}`;
	}
	if (TypeGuard.IsIntersect(schema)) return schema.allOf.map((member) => {
		const declaration = declarationOf(member);
		return TypeGuard.IsUnion(member) || TypeGuard.IsFunction(member) ? `(${declaration})` : declaration;
	}).join(" & ");
	return "unknown";
};

// @approved
//  The `.d.ts` of the sandbox: each global declared from its schema, with
// the `console` the prelude provides. A name that is not an identifier,
// such as a hyphenated one, cannot be declared as a const, so it is
// described with the bracket access that reaches it.
const declarations = (globals: Readonly<Record<string, CodeAgentGlobal>>) => [
	...Object.entries(globals).map(([name, global]) => identifier.test(name)
		? `/** ${global.description} */\ndeclare const ${name}: ${declarationOf(global.schema)};`
		: `/** ${global.description} */\n// Reach it with bracket access: globalThis[${JSON.stringify(name)}]: ${declarationOf(global.schema)}`),
	"declare const console: { log(...values: unknown[]): void };",
].join("\n");

// @approved
//  The guest side of the run tool: `console.log` renders each argument and
// buffers the line, clipped to the output limit, so a huge log never crosses
// the boundary whole and a million logs never cross one by one. `determinism`
// (sandboxed.ts) has already taken the clock and `Math.random`, so equal
// inputs give equal outcomes.
const prelude = `(() => {
	let output = "";
	const limit = ${CODE_AGENT_OUTPUT_BYTES};
	const stringify = JSON.stringify;
	const show = (value) => {
		try {
			const shown = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
			return shown.length > limit ? shown.slice(0, limit) : shown;
		} catch { return "a value that cannot be shown"; }
	};
	globalThis.console = { log: (...values) => {
		if (output.length >= limit) return;
		const line = (values.length === 0 ? ["undefined"] : values).map(show).join(" ");
		output += (output === "" ? "" : "\\n") + line.slice(0, limit - output.length);
	} };
	return { take: () => { const text = output; output = ""; return stringify(text); } };
})()`;

// @approved
//  The guest helpers the host calls with handles, never named in the guest:
// `take` empties the log buffer into one string the host reads once per
// `run`, `show` returns a run's final value as JSON (or why it cannot),
// capped at the output limit, `json` refuses a global function's argument
// unless it survives as JSON, before anything crosses, and `freeze` freezes
// an injected global deeply, in place. The whole block is one expression,
// so nothing it defines leaks into the guest's global scope.
const helpers = `(() => {
	const defineProperty = Object.defineProperty;
	const survives = (left, right) => {
		if (left === right) return true;
		if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
		if (!Array.isArray(left) && Object.getPrototypeOf(left) !== Object.prototype && Object.getPrototypeOf(left) !== null) return false;
		if (Object.getOwnPropertySymbols(left).length !== 0 || Object.getOwnPropertySymbols(right).length !== 0) return false;
		const keys = Object.keys(left);
		if (keys.length !== Object.keys(right).length) return false;
		for (const key of keys) if (!Object.prototype.hasOwnProperty.call(right, key) || !survives(left[key], right[key])) return false;
		return true;
	};
	return {
		define: (object, key, value) => { defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true }); },
		parse: JSON.parse,
		show: (value, limit) => {
			if (value === undefined) return "undefined";
			let shown;
			try { shown = JSON.stringify(value); } catch { return "a value JSON cannot show; return a JSON value"; }
			if (shown === undefined) return "a value JSON cannot show; return a JSON value";
			return shown.length > limit ? shown.slice(0, limit) : shown;
		},
		json: (value) => {
			const text = JSON.stringify(value);
			if (text === undefined) throw new TypeError("a global function takes JSON, and this argument is a " + typeof value);
			if (!survives(value, JSON.parse(text))) throw new TypeError("a global function takes JSON, and this argument does not survive as JSON (dropped values, NaN or a non-plain object)");
			return text;
		},
		freeze: (value) => {
			const freeze = (item) => {
				if (item !== null && (typeof item === "object" || typeof item === "function")) { Object.freeze(item); for (const key of Object.keys(item)) freeze(item[key]); }
				return item;
			};
			return freeze(value);
		},
	};
})()`;

const isFunction = (value: CodeAgentValue): value is CodeAgentFunction => typeof value === "function";
const isNumber = (value: CodeAgentValue): value is number => typeof value === "number";
const isText = (value: CodeAgentValue): value is string => typeof value === "string";

// @approved
//  The agent's QuickJS guest: one runtime and context for the whole run, on
// its own WebAssembly instance and capped memory, holding the frozen
// `globals` and a `console.log` that buffers what the code logs. Each `run`
// call evaluates its code in the global scope under the deadline, so a
// variable set in one call is there in the next, and answers the logged
// lines and the code's final value as JSON, cut off at the output limit.
// Nothing host-side but the log capture and the function values the Box
// itself handed it is reachable: the wasmfile build has no network or
// filesystem, `determinism` removes the clock and `Math.random`, and the
// helpers the host calls are never named in the guest.
const codeGuest = async (id: BoxId, globals: Readonly<Record<string, CodeAgentGlobal>>) => {
	const { runtime, enter, expired } = await guestRuntime(CODE_AGENT_HEAP_BYTES, CODE_AGENT_CALL_MS);
	const vm = runtime.newContext();
	const kept: QuickJSHandle[] = [];
	const dispose = () => {
		for (const handle of kept.splice(0)) {
			try { handle.dispose(); } catch { /* @approved A trapped heap owns handles the host can no longer free. */ }
		}
		try { vm.dispose(); } catch { /* @approved A failed run drops its context; the host GC reclaims what cannot be freed. */ }
		try { runtime.dispose(); } catch { /* @approved A trapped Wasm heap is reclaimed whole by the host GC. */ }
	};
	const failureOf = (handle: QuickJSHandle): SandboxedFailure => {
		try {
			const dumped: unknown = vm.dump(handle);
			return Value.Check(sandboxedFailure, dumped) ? dumped : { name: "Error", message: String(dumped) };
		} finally { handle.dispose(); }
	};
	const failed = (failure: SandboxedFailure): Error => guestError(id, "code", CODE_AGENT_LIMITS, failure);
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
	/** @approved The binding's C strings truncate NUL and UTF-8 cannot carry lone surrogates. */
	const stringHandle = (value: string): QuickJSHandle => {
		if (!value.includes("\u0000") && value.isWellFormed()) return vm.newString(value);
		using encoded = vm.newString(JSON.stringify(value));
		return call(parse, encoded);
	};
	// @approved
	//  One global's value as guest handles: JSON leaves become guest values,
	// and a function leaf becomes a host function the guest calls with JSON it
	// proves in the guest first, dumping the proved text in and building the
	// answer out again, so a call crosses as JSON alone.
	const build = (value: CodeAgentValue, name: string): QuickJSHandle => {
		if (isFunction(value)) return vm.newFunction(name, (input, ...extra) => {
			if (extra.length > 0) throw new TypeError("A code agent function global takes at most one JSON input.");
			// @approved
			//  A call with no argument, or an explicit undefined one, hands the Box
			// undefined.
			if (input === undefined || vm.typeof(input) === "undefined") return through(value(undefined), name);
			// @approved
			//  The argument is proved JSON in the guest first, so a refusal the
			//  guest can see crosses nothing and the Box's own function never
			//  runs; its error is handed straight back to the guest caller.
			const guarded = vm.callFunction(json, vm.undefined, input);
			if (guarded.error !== undefined) return guarded;
			const text = vm.getString(guarded.value!);
			guarded.value!.dispose();
			return through(value(JSON.parse(text)), name);
		});
		if (value === null) return vm.null;
		if (isNumber(value)) return vm.newNumber(value);
		if (isText(value)) return stringHandle(value);
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
			using property = stringHandle(key);
			using handle = build(item, `${name}.${key}`);
			call(define, object, property, handle).dispose();
		}
		return object;
	};
	// @approved
	//  A host function's answer, or a value the guest refused to prove JSON:
	//  the guest sees it as `undefined` when the Box gave none.
	const through = (answer: CodeAgentValue | undefined, name: string): QuickJSHandle => answer === undefined ? vm.undefined : build(answer, name);
	// @approved
	//  The buffered logs, emptied once per `run` call: the guest hands the
	//  whole buffer over as one string, so no log crosses on its own.
	const readLogs = (): string => {
		enter();
		const logs = call(take);
		const text: string = JSON.parse(vm.getString(logs));
		logs.dispose();
		return text;
	};
	const logged = (logs: string): string => logs === "" ? "" : `Logged:\n${logs}\n\n`;
	const runFailure = (failure: SandboxedFailure): CodeAgentRun => {
		const error = failed(failure);
		return guestLimit(failure) ? { output: error.message, failure: error } : { output: fit(`${logged(readLogs())}${error.message}`) };
	};
	// @approved
	//  One `run` call: evaluation and queued jobs share a deadline. The reply
	// holds the buffered logs and the final value, or says why
	// the code stopped. The heap and time limits end the run, answered with
	// their reason alone: after an exhausted heap, no guest call can be
	// counted on to run. A guest throw is the call's output, so the model can
	// fix its code and go on.
	const run = (code: string): CodeAgentRun => {
		try {
			enter();
			const result = vm.evalCode(code, "run.js", { type: "global" });
			const failure = result.error === undefined ? undefined : failureOf(result.error);
			if (failure !== undefined && guestLimit(failure)) return runFailure(failure);
			using value = result.value;
			while (!expired() && runtime.hasPendingJob()) {
				const jobs = runtime.executePendingJobs(64);
				if (jobs.error !== undefined) return runFailure(failureOf(jobs.error));
			}
			if (expired()) return runFailure({ name: "InternalError", message: "interrupted" });
			if (failure !== undefined) return runFailure(failure);
			const logs = readLogs();
			using shown = call(show, value!, limit); // @approved A call result holds a value exactly when it holds no error.
			return { output: fit(`${logged(logs)}Returned:\n${vm.getString(shown)}`) };
		} catch (error) {
			if (!(error instanceof WebAssembly.RuntimeError)) throw error;
			const trapped = failed({ name: error.name, message: error.message });
			return { output: trapped.message, failure: trapped };
		}
	};
	let show: QuickJSHandle;
	let limit: QuickJSHandle;
	let json: QuickJSHandle;
	let take: QuickJSHandle;
	let define: QuickJSHandle;
	let parse: QuickJSHandle;
	try {
		evaluate(determinism, "determinism.js").dispose();
		const bridge = evaluate(prelude, "prelude.js");
		take = vm.getProp(bridge, "take");
		bridge.dispose();
		kept.push(take);
		const helperObject = evaluate(helpers, "helpers.js");
		show = vm.getProp(helperObject, "show");
		json = vm.getProp(helperObject, "json");
		define = vm.getProp(helperObject, "define");
		parse = vm.getProp(helperObject, "parse");
		const freeze = vm.getProp(helperObject, "freeze");
		helperObject.dispose();
		kept.push(show, json, define, parse, freeze);
		limit = vm.newNumber(CODE_AGENT_OUTPUT_BYTES);
		kept.push(limit);
		for (const [name, global] of Object.entries(globals)) {
			using property = stringHandle(name);
			using handle = build(global.value, name);
			const frozen = call(freeze, handle);
			frozen.dispose();
			// @approved
			//  The name is defined, not set: the agent cannot write over or
			//  delete its own globals, though the values were already frozen.
			vm.defineProp(vm.global, property, { value: handle, configurable: false, enumerable: true });
		}
	} catch (error) {
		dispose();
		throw error;
	}
	return { run, dispose };
};

// @approved
//  Every code agent runs on the default delegate model; no Box has a model
// of its own for it.
const agentModel = (database: Database) => resolveBoxDelegate(database, DEFAULT_BOX_DELEGATE);
const unavailableReason = (setting: Exclude<ReturnType<typeof agentModel>, { kind: "ready" }>) =>
	setting.kind === "broken" ? setting.reason : "No agent model is chosen; choose the Default delegate model in Connections.";

/** @approved Why a code-agent run would be refused before it starts, or undefined when the default delegate model is ready, for a control to say before the writer starts one. */
export const codeAgentUnavailable = (database: Database): string | undefined => {
	const setting = agentModel(database);
	return setting.kind === "ready" ? undefined : unavailableReason(setting);
};

// @approved
//  One code-agent run: a libfx agent on the default delegate model, built
// for this run and closed with it, whose two tools work one QuickJS context
// the run owns and disposes however it ends. `run` explores the frozen
// globals; `submit` checks the draft against `submitSchema`, then the Box's
// own `verify`, and either refusal goes back to the model as a tool error,
// so the first valid draft ends the run and is its result. A model request
// and a tool call count against the same step cap, which no valid submit
// can pass: a run that failed fails, whatever its last tool call returned.
// The run's signal cancels the turn and its fetches, and a run that ends,
// fails or is cancelled leaves no QuickJS context behind.
export const runCodeAgent = async <Draft extends TSchema>(database: Database, request: CodeAgentCall<Draft>): Promise<Static<Draft>> => {
	const { boxId, instructions, globals, submitSchema, verify, signal, onActivity } = request;
	const setting = agentModel(database);
	if (setting.kind !== "ready") throw new Error(unavailableReason(setting));
	signal.throwIfAborted();
	const globalDeclarations = declarations(globals);
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
	try {
		const agent = createFxAgent({
			// @approved
			//  The declarations go in the instructions, not the run tool's
			// description: libfx cuts every tool description at 1024 characters.
			backend: "wasm", durability: memory(), name: "code-agent",
			instructions: `${instructions}\n\nThe code the run tool runs sees only these globals:\n\n${globalDeclarations}`,
			tools: [{
				name: "run", idempotent: false, writes: true,
				description: [
					`Runs JavaScript in a sandbox and returns what console.log printed and the code's final value as JSON, cut off at ${CODE_AGENT_OUTPUT_BYTES / 1024} KiB.`,
					"One context lasts the whole run, so a variable set in one call is there in the next. There is no network, filesystem, clock or randomness.",
					"The globals it sees are declared in the instructions.",
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
					// @approved
					//  A limit failure is recorded before the writer's window
					//  onto it opens, so an onActivity that throws cannot leave
					//  the run running past the limit it already passed.
					if (outcome.failure !== undefined) stop(outcome.failure.message);
					onActivity({ summary: summarized(proposed.code), code: proposed.code, output: outcome.output });
					if (outcome.failure !== undefined) fail(outcome.failure.message);
					return outcome.output;
				},
			}, {
				name: "submit", idempotent: false, writes: true,
				description: [
					"Submits the run's result and ends the run.",
					"The draft is checked against its schema and the Box's own rules; either refusal comes back with its reason, and the first valid draft is the run's result.",
				].join(" "),
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
			const turn = agent.session().prompt("Begin.", { signal: aborted });
			const result = await turn.result.catch((error: unknown) => ({ stopReason: "error" as const, error: { message: error instanceof Error ? error.message : String(error) } }));
			signal.throwIfAborted();
			if (failure !== undefined) throw new Error(failure);
			if (submitted !== undefined) return submitted;
			if (result.stopReason === "error") throw new Error(`The agent's model request failed: ${result.error?.message ?? "no reason given"}`);
			throw new Error(refusal ?? "The agent ended without submitting a draft.");
		} finally {
			await agent.close().catch(() => undefined);
		}
	} finally {
		guest.dispose();
	}
};
