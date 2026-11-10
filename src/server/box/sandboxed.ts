import { Value } from "@sinclair/typebox/value";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten-core";
import type { BoxId } from "../../shared/contract/box";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { sandboxedDeclaration, sandboxedDecideInput, sandboxedFailure, sandboxedOutcome, sandboxedReadOutput, type SandboxedFailure } from "../../shared/contract/box-sandboxed";
import type { BoxValue } from "../../shared/contract/box-value";
import type { Portrait } from "../../shared/contract/image";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { DecisionJson, DecisionQuestions } from "../decision-model";
import type { AdvanceInput, BoxWindowRead, CaptureRead, DigestContext, DigestWindow } from "./contract";
import { boxSnapshot } from "./snapshot";

/** @approved The JSON a hook call may carry in each direction, checked before the host allocates a guest string. */
export const SANDBOX_JSON_BYTES = 4 * 1024 * 1024;
/** @approved Each sandboxed Box's QuickJS heap: the most its WebAssembly memory may grow to. */
export const SANDBOX_HEAP_BYTES = 64 * 1024 * 1024;
const WASM_PAGE_BYTES = 64 * 1024;
/** @approved Guest execution per entry into the guest: evaluating `logic.js`, each hook call and each job pump. */
export const SANDBOX_ENTRY_MS = 100;

/** @approved The hooks a sandboxed Box may declare in this SDK; any other key its `logic.js` exports is refused. */
const supportedHooks = ["setupError", "dependencies", "moves.render", "records.initial", "records.fold", "records.digest.window", "records.digest.run", "advance.run", "read", "status"];

// @approved
//  Runs in the guest context before `logic.js`: logic has no clock and no
// randomness of its own, so equal inputs give equal outcomes. A Date with
// arguments still works, so a Box can format a time it was given. The real
// constructor stays inside the function, out of the guest's reach.
const determinism = `(() => {
	delete Math.random;
	const RealDate = Date;
	const construct = Reflect.construct;
	const NoClock = new Proxy(RealDate, {
		construct: (target, args, newTarget) => { if (args.length === 0) throw new TypeError("Sandboxed logic has no clock."); return construct(target, args, newTarget); },
		apply: () => { throw new TypeError("Sandboxed logic has no clock."); },
	});
	delete RealDate.now;
	RealDate.prototype.constructor = NoClock;
	globalThis.Date = NoClock;
})();`;

// @approved
//  Called with the module's default export: it returns which hooks the
// module declares, its initial state and its digest window, as JSON, and the
// dispatcher every hook call enters through. Each call's input crosses as a
// JSON string, and each outcome returns as a JSON envelope,
// `{ kind: "ok", value }` or `{ kind: "error", name, message }`, so only
// strings cross the boundary. `read` also receives the host's `snapshot`,
// which takes and returns JSON strings too, and a digest the host's
// `decide`, which takes a JSON string and returns a Promise of one.
// `advance.run` and a digest may be async; every other hook must return its
// value.
const bridge = `(box) => {
	const walk = (path, value) => path !== "records.initial" && value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.entries(value).flatMap(([key, inner]) => walk(path === "" ? key : path + "." + key, inner)) : [[path, typeof value]];
	const declared = box !== null && typeof box === "object" ? walk("", box) : [];
	const ok = (value) => JSON.stringify({ kind: "ok", value });
	const fail = (error) => {
		try { return JSON.stringify({ kind: "error", name: String(error?.name ?? "Error"), message: String(error?.message ?? error) }); }
		catch { return JSON.stringify({ kind: "error", name: "Error", message: "An error that cannot be shown." }); }
	};
	const hooks = {
		setupError: ([setup, previous]) => box.setupError(setup, previous),
		dependencies: ([read, setup]) => box.dependencies(read, setup),
		"moves.render": ([move, author]) => box.moves.render(move, author),
		"records.fold": ({ state, records, setup }) => records.reduce((folded, record) => box.records.fold(folded, record, setup), state),
		"advance.run": (input) => box.advance.run(input),
		"records.digest.run": (window, decide) => box.records.digest.run(window, { decide: (state, questions) => decide(JSON.stringify([state, questions])).then(JSON.parse) }),
		read: (read, snapshot) => box.read(read, { snapshot: (query) => JSON.parse(snapshot(JSON.stringify(query))) }),
		status: ([setup, state]) => box.status(setup, state),
	};
	const dispatch = (hook, json, capability) => {
		if (hook === "advance.run" || hook === "records.digest.run") {
			try { return Promise.resolve(hooks[hook](JSON.parse(json), capability)).then(ok, fail); } catch (error) { return Promise.resolve(fail(error)); }
		}
		try {
			const value = hooks[hook](JSON.parse(json), capability);
			if (typeof value?.then === "function") throw new TypeError(hook + " returned a Promise; only advance.run and records.digest.run may be async.");
			return ok(value);
		} catch (error) { return fail(error); }
	};
	return [JSON.stringify({ declared, initial: box?.records?.initial, window: box?.records?.digest?.window }), dispatch];
}`;

// @approved
//  QuickJS's own memory limit does not bound this build's heap: it let a
// guest grow past 2 GiB of strings, arrays or ArrayBuffers. So each Box gets
// its own instance of the one compiled module, on a WebAssembly memory that
// cannot grow past the heap limit; an allocation past it fails in the guest
// as out of memory. The variant's memory starts at 16 MiB.
const compiled = Bun.file(Bun.resolveSync("@jitl/quickjs-wasmfile-release-sync/wasm", import.meta.dir)).arrayBuffer().then((bytes) => WebAssembly.compile(bytes));
const quickjs = async () => newQuickJSWASMModuleFromVariant(newVariant(variant, {
	wasmModule: await compiled,
	wasmMemory: new WebAssembly.Memory({ initial: 16 * 1024 * 1024 / WASM_PAGE_BYTES, maximum: SANDBOX_HEAP_BYTES / WASM_PAGE_BYTES }),
}));
const mebibytes = (bytes: number) => `${bytes / 1024 / 1024} MiB`;

/** @approved A QuickJS runtime on its own module instance and capped memory, with the deadline each entry into its guest arms. */
const guestRuntime = async () => {
	const runtime = (await quickjs()).newRuntime();
	let deadline = 0;
	runtime.setInterruptHandler(() => performance.now() > deadline);
	return { runtime, enter: () => { deadline = performance.now() + SANDBOX_ENTRY_MS; } };
};
type GuestRuntime = Awaited<ReturnType<typeof guestRuntime>>;

/** @approved A guest failure as the host words it, naming the Box and the hook it stopped. */
const guestError = (id: BoxId, hook: string, { name, message }: SandboxedFailure) =>
	new Error(name === "InternalError" && message === "interrupted" ? `The ${id} Box's ${hook} ran past its ${SANDBOX_ENTRY_MS} ms limit.`
		: name === "InternalError" && message === "out of memory" ? `The ${id} Box's ${hook} ran out of its ${mebibytes(SANDBOX_HEAP_BYTES)} heap.`
		: `The ${id} Box's ${hook} threw ${name}: ${message}`);

/** @approved What a sandboxed Box's `read` gets: its setup and folded state, the Cast with each Portrait and source Character, and the human seat. */
export type SandboxedReadInput = {
	readonly setup: BoxValue | undefined;
	readonly state: GenerationJsonValue | undefined;
	readonly human: number | null;
	readonly cast: readonly { readonly id: number; readonly name: string; readonly portrait: Portrait | null; readonly character: { readonly id: number; readonly name: string | null } | null }[];
};

const overLimit = (id: BoxId, hook: string, direction: "input" | "result") => new Error(`The ${id} Box's ${hook} ${direction} is over the ${mebibytes(SANDBOX_JSON_BYTES)} limit.`);

// @approved
//  A sandboxed Box: its `logic.js`, an ES module with no imports, evaluated in
// its own QuickJS runtime, behind the hooks the host calls on any Box. Hooks
// that receive no capability share one long-lived context. `read` receives
// `snapshot`, bound to the Chat it reads, so each read evaluates `logic.js`
// in a fresh context that is disposed when it returns, and a digest receives
// `decide`, bound to its job, so each digest evaluates it in a runtime of its
// own, thrown away whole once the digest settles: no global keeps the
// capability for a later or concurrent call, and a digest that fails halfway
// leaves nothing behind for the next. Each entry into the guest arms the
// interrupt deadline, and the byte limit refuses a call's JSON before the
// guest sees it and its reply before the host copies it. `dispose` frees the
// runtime once the registry drops it.
export const sandboxedBox = async (id: BoxId, source: string) => {
	const long = await guestRuntime();

	/** @approved One guest context on `runtime` with `logic.js` evaluated in it, and the calls into its dispatcher. */
	const open = ({ runtime, enter }: GuestRuntime) => {
		const vm = runtime.newContext();
		let dispatch: QuickJSHandle | undefined;
		const dispose = () => {
			dispatch?.dispose();
			vm.dispose();
		};
		// @approved
		//  A guest error, read and freed: an Error dumps as its name and message,
		// and anything else a guest throws reads as its text.
		const failure = (handle: QuickJSHandle): SandboxedFailure => {
			try {
				const dumped: unknown = vm.dump(handle);
				return Value.Check(sandboxedFailure, dumped) ? dumped : { name: "Error", message: String(dumped) };
			} finally { handle.dispose(); }
		};
		const unwrap = (hook: string, result: { error?: QuickJSHandle; value?: QuickJSHandle }): QuickJSHandle => {
			if (result.error !== undefined) throw guestError(id, hook, failure(result.error));
			return result.value!; // @approved A call result holds a value exactly when it holds no error.
		};
		// @approved
		//  Pumps the guest's jobs until `promise` settles, each pump under a fresh
		// deadline, and returns its value's handle, or undefined once no job is
		// left and it is still pending.
		const pumped = (hook: string, promise: QuickJSHandle): QuickJSHandle | undefined => {
			for (let idle = false; ; ) {
				const state = vm.getPromiseState(promise);
				// @approved
				// A module without top-level await evaluates to its namespace, which reads as already fulfilled with the same handle.
				if (state.type === "fulfilled") return state.notAPromise === true ? promise.dup() : state.value;
				if (state.type === "rejected") throw guestError(id, hook, failure(state.error));
				if (idle) return undefined;
				enter();
				const jobs = runtime.executePendingJobs();
				if (jobs.error !== undefined) throw guestError(id, hook, failure(jobs.error));
				idle = jobs.value === 0;
			}
		};
		const neverSettled = (hook: string) => new Error(`The ${id} Box's ${hook} never settled.`);
		/** @approved With no host operation in flight, a promise still pending once no job is left never settles. */
		const settled = (hook: string, promise: QuickJSHandle): QuickJSHandle => {
			try {
				const value = pumped(hook, promise);
				if (value === undefined) throw neverSettled(hook);
				return value;
			} finally { promise.dispose(); }
		};
		/** @approved Settles `promise` while host operations answer it: `waiting` hands over the next one in flight, which the pump awaits before it pumps again. */
		const settledAsync = async (hook: string, promise: QuickJSHandle, waiting: () => Promise<void> | undefined): Promise<QuickJSHandle> => {
			try {
				for (;;) {
					const value = pumped(hook, promise);
					if (value !== undefined) return value;
					const next = waiting();
					if (next === undefined) throw neverSettled(hook);
					await next;
				}
			} finally { promise.dispose(); }
		};
		const evaluate = (code: string, file: string, type: "global" | "module") => {
			enter();
			return unwrap(file, vm.evalCode(code, file, { type }));
		};
		const text = (hook: string, handle: QuickJSHandle) => {
			try {
				if (vm.typeof(handle) !== "string") throw new Error(`The ${id} Box's ${hook} returned no envelope.`);
				const length = vm.getProp(handle, "length");
				const units = vm.getNumber(length);
				length.dispose();
				const reply = units > SANDBOX_JSON_BYTES ? undefined : vm.getString(handle);
				// @approved
				// UTF-8 is never shorter than the string's UTF-16 length, so the length refuses an oversized reply before it is copied out.
				if (reply === undefined || Buffer.byteLength(reply) > SANDBOX_JSON_BYTES) throw overLimit(id, hook, "result");
				return reply;
			} finally { handle.dispose(); }
		};
		try {
			evaluate(determinism, "determinism.js", "global").dispose();
			const namespace = settled("logic.js", evaluate(source, "logic.js", "module"));
			const exported = vm.getProp(namespace, "default");
			namespace.dispose();
			const factory = evaluate(bridge, "bridge.js", "global");
			enter();
			const built = vm.callFunction(factory, vm.undefined, exported);
			factory.dispose();
			exported.dispose();
			const pair = unwrap("logic.js", built);
			const declarationText = vm.getProp(pair, 0);
			dispatch = vm.getProp(pair, 1);
			pair.dispose();
			const declaration: unknown = JSON.parse(text("logic.js", declarationText));
			assertChecked(sandboxedDeclaration, declaration, `The ${id} Box's logic.js declaration`);
			const enterHook = dispatch;
			// @approved
			//  A capability: a host function the guest calls with a JSON string,
			// held to the byte limit. `answer` returns the guest's handle on its
			// reply, a JSON string built with `reply` or a Promise the host
			// settles later.
			const capability = (name: string, answer: (json: string) => QuickJSHandle) => vm.newFunction(name, (argument) => {
				const json = vm.getString(argument);
				if (Buffer.byteLength(json) > SANDBOX_JSON_BYTES) throw overLimit(id, name, "input");
				return answer(json);
			});
			const reply = (name: string, json: string) => {
				if (Buffer.byteLength(json) > SANDBOX_JSON_BYTES) throw overLimit(id, name, "result");
				return vm.newString(json);
			};
			/** @approved One call into the dispatcher, handing over `capability`, which the call frees. */
			const call = (hook: string, json: string, capability?: QuickJSHandle) => {
				try {
					if (Buffer.byteLength(json) > SANDBOX_JSON_BYTES) throw overLimit(id, hook, "input");
					const name = vm.newString(hook);
					const argument = vm.newString(json);
					enter();
					const result = vm.callFunction(enterHook, vm.undefined, name, argument, ...capability === undefined ? [] : [capability]);
					name.dispose();
					argument.dispose();
					return unwrap(hook, result);
				} finally { capability?.dispose(); }
			};
			return { vm, declaration, call, capability, reply, text, settled, settledAsync, dispose };
		} catch (error) {
			dispose();
			throw error;
		}
	};

	let shared: ReturnType<typeof open> | undefined;
	const dispose = () => {
		shared?.dispose();
		long.runtime.dispose();
	};
	try {
		shared = open(long);
		const { declaration, call, text, settled } = shared;
		if (declaration.declared.length === 0) throw new Error(`The ${id} Box's logic.js must default-export an object of hooks.`);
		const declared = new Map(declaration.declared.map(([key, kind]) => [key, kind] as const));
		const unsupported = [...declared.keys()].filter((key) => !supportedHooks.includes(key));
		if (unsupported.length > 0) throw new Error(`The ${id} Box's logic.js declares ${unsupported.join(", ")}, which a sandboxed Box cannot.`);
		const notFunctions = [...declared].filter(([key, kind]) => key !== "records.initial" && key !== "records.digest.window" && kind !== "function").map(([key]) => key);
		if (notFunctions.length > 0) throw new Error(`The ${id} Box's logic.js declares ${notFunctions.join(", ")}, which must be functions.`);

		const outcome = (hook: string, reply: string): GenerationJsonValue | undefined => {
			const parsed: unknown = JSON.parse(reply);
			assertChecked(sandboxedOutcome, parsed, `The ${id} Box's ${hook} outcome`);
			if (parsed.kind === "error") throw guestError(id, hook, parsed);
			// @approved
			// SAFETY: JSON.parse returns only JSON values, and the registry checks this one against the hook's output schema.
			return parsed.value as GenerationJsonValue | undefined;
		};
		const sync = (hook: string, json: string) => outcome(hook, text(hook, call(hook, json)));
		type State = GenerationJsonValue | undefined;
		type Setup = BoxValue | undefined;
		const foldAll = (state: State, records: readonly GenerationJsonValue[], setup: Setup) => sync("records.fold", JSON.stringify({ state, records, setup }));
		// @approved
		//  The guest's `read`: its view and Status line, which it builds from its
		// setup, state and Cast, and its own stored values through `snapshot`,
		// which answers each query as JSON. A Chat's window read hands it the
		// production `boxSnapshot`; a scenario hands it scripted answers.
		const guestRead = (input: SandboxedReadInput, snapshot: (query: string) => string) => {
			const fresh = open(long);
			try {
				const output = outcome("read", fresh.text("read", fresh.call("read", JSON.stringify(input), fresh.capability("snapshot", (query) => fresh.reply("snapshot", snapshot(query))))));
				assertChecked(sandboxedReadOutput, output, `The ${id} Box's read result`);
				return output;
			} finally { fresh.dispose(); }
		};
		// @approved
		//  The window read: the guest's read over this Chat, and the Chat revision
		// it read at, which its commits name as their snapshot.
		const read = ({ db, conversationId, summary, setup, state }: BoxWindowRead<Setup, State>) => {
			const output = guestRead({
				setup, state, human: summary.control.humanParticipantId,
				cast: summary.cast.map(({ id: participantId, name, portrait, sourceCharacterId, sourceCharacterName }) => ({
					id: participantId, name, portrait: portrait ?? null, character: sourceCharacterId === null ? null : { id: sourceCharacterId, name: sourceCharacterName },
				})),
			}, boxSnapshot(db, id, conversationId));
			return { snapshot: summary.revision, status: output.status ?? null, view: output.view };
		};
		// @approved
		//  A digest runs in a runtime of its own, created for this call with
		// `decide` bound to its job and dropped once it settles, so neither
		// `advance` nor a concurrent digest can reach `decide`, and a digest
		// stopped halfway, its promise chains and heap included, cannot poison
		// a later one. `decide` asks the Box's own Decision Model selection
		// through the job's context, once per call, and answers with the
		// answers as entries. When the job is superseded or dropped, its signal
		// aborts the request, the pending `decide` rejects in the guest, a late
		// answer is dropped, and the digest fails, so nothing lands. However the
		// call ends, its request is aborted with it, so no request outlives
		// the digest that made it.
		const digest = async (window: DigestWindow, ctx: DigestContext) => {
			const fresh = open(await guestRuntime());
			// @approved
			// A job dropped while its runtime was created never runs: from here to the listener below nothing yields, so no abort goes unseen.
			ctx.signal.throwIfAborted();
			const invocation = new AbortController();
			let asked = false;
			let deferred: QuickJSDeferredPromise | undefined;
			let wake: Promise<void> | undefined;
			let woken = () => {};
			const answer = (settle: (pending: QuickJSDeferredPromise) => void) => {
				const pending = deferred;
				deferred = undefined;
				if (pending === undefined) return;
				settle(pending);
				pending.dispose();
				woken();
			};
			const reject = ({ name, message }: Error) => answer((pending) => {
				const handle = fresh.vm.newError({ name, message });
				pending.reject(handle);
				handle.dispose();
			});
			const cancel = () => reject(new Error(`The ${id} Box's digest was cancelled.`));
			ctx.signal.addEventListener("abort", cancel);
			const decide = fresh.capability("decide", (json) => {
				if (asked) throw new Error("decide may be called once per digest.");
				asked = true;
				const input: unknown = JSON.parse(json);
				assertChecked(sandboxedDecideInput, input, `The ${id} Box's decide input`);
				const pending = fresh.vm.newPromise();
				const handle = pending.handle.dup();
				deferred = pending;
				wake = new Promise((resolve) => { woken = resolve; });
				void (async () => {
					try {
						// @approved
						// SAFETY: the input is parsed JSON, so its state is JSON, and its questions passed their schema.
						const answers = await ctx.decide(input[0] as DecisionJson, input[1] as DecisionQuestions, { signal: invocation.signal });
						const json = JSON.stringify([...answers]);
						if (Buffer.byteLength(json) > SANDBOX_JSON_BYTES) throw overLimit(id, "decide", "result");
						answer((settling) => {
							const text = fresh.vm.newString(json);
							settling.resolve(text);
							text.dispose();
						});
					} catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
				})();
				return handle;
			});
			try {
				const run = fresh.call("records.digest.run", JSON.stringify(window), decide);
				const settledRun = await fresh.settledAsync("records.digest.run", run, () => {
					const next = wake;
					wake = undefined;
					return next;
				});
				const value = outcome("records.digest.run", fresh.text("records.digest.run", settledRun));
				ctx.signal.throwIfAborted();
				return value;
			} finally {
				ctx.signal.removeEventListener("abort", cancel);
				invocation.abort();
				// @approved
				//  The runtime is dropped, not disposed: freeing one stopped inside a
				// promise chain fails QuickJS's leak assertion, and nothing else
				// holds its module instance, so the garbage collector reclaims its
				// memory whole.
				deferred = undefined;
			}
		};
		const box = {
			...declared.has("status") && { status: (setup: Setup, state: State) => sync("status", JSON.stringify([setup, state])) },
			...declared.has("setupError") && { setupError: (setup: Setup, previous: Setup) => sync("setupError", JSON.stringify([setup, previous])) },
			...declared.has("dependencies") && { dependencies: ({ seed, intent, cast }: Pick<CaptureRead, "seed" | "intent" | "cast">, setup: Setup) => sync("dependencies", JSON.stringify([{ seed, intent, cast }, setup])) },
			...declared.has("moves.render") && { moves: { render: (move: BoxValue, author: string) => sync("moves.render", JSON.stringify([move, author])) } },
			...(declared.has("records.initial") || declared.has("records.fold") || declared.has("records.digest.run")) && { records: {
				...declared.has("records.initial") && { initial: declaration.initial },
				...declared.has("records.fold") && { fold: (state: State, record: GenerationJsonValue, setup: Setup) => foldAll(state, [record], setup), foldAll },
				...declared.has("records.digest.run") && { digest: { window: declaration.window, run: digest } },
			} },
			...declared.has("advance.run") && { advance: {
				run: async ({ setup, dependencies, state, moves }: AdvanceInput<Setup, unknown, State, BoxValue>) =>
					outcome("advance.run", text("advance.run", settled("advance.run", call("advance.run", JSON.stringify({ setup, dependencies, state, moves }))))),
			} },
			...declared.has("read") && { read },
		};
		return { box, guestRead: declared.has("read") ? guestRead : undefined, dispose };
	} catch (error) {
		dispose();
		throw error;
	}
};
