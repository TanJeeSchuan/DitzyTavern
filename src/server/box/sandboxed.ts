import { Value } from "@sinclair/typebox/value";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSHandle } from "quickjs-emscripten-core";
import type { BoxId } from "../../shared/contract/box";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { sandboxedDeclaration, sandboxedFailure, sandboxedOutcome, sandboxedReadOutput, type SandboxedFailure } from "../../shared/contract/box-sandboxed";
import type { BoxValue } from "../../shared/contract/box-value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { AdvanceInput, BoxWindowRead, CaptureRead } from "./contract";
import { boxSnapshot } from "./snapshot";

/** @approved The JSON a hook call may carry in each direction, checked before the host allocates a guest string. */
export const SANDBOX_JSON_BYTES = 4 * 1024 * 1024;
/** @approved Each sandboxed Box's QuickJS heap: the most its WebAssembly memory may grow to. */
export const SANDBOX_HEAP_BYTES = 64 * 1024 * 1024;
const WASM_PAGE_BYTES = 64 * 1024;
/** @approved Guest execution per entry into the guest: evaluating `logic.js`, each hook call and each job pump. */
export const SANDBOX_ENTRY_MS = 100;

/** @approved The hooks a sandboxed Box may declare in this SDK; any other key its `logic.js` exports is refused. */
const supportedHooks = ["setupError", "dependencies", "moves.render", "records.initial", "records.fold", "advance.run", "read"];

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
// module declares and its initial state, as JSON, and the dispatcher every
// hook call enters through. Each call's input crosses as a JSON string, and
// each outcome returns as a JSON envelope, `{ kind: "ok", value }` or
// `{ kind: "error", name, message }`, so only strings cross the boundary.
// `read` also receives the host's `snapshot`, which takes and returns JSON
// strings too. `advance.run` may be async; every other hook must return its
// value.
const bridge = `(box) => {
	const declared = box !== null && typeof box === "object" ? Object.entries(box).flatMap(([key, value]) =>
		value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).map(([inner, hook]) => [key + "." + inner, typeof hook]) : [[key, typeof value]]) : [];
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
		read: (read, snapshot) => box.read(read, { snapshot: (query) => JSON.parse(snapshot(JSON.stringify(query))) }),
	};
	const dispatch = (hook, json, capability) => {
		if (hook === "advance.run") {
			try { return Promise.resolve(hooks[hook](JSON.parse(json))).then(ok, fail); } catch (error) { return Promise.resolve(fail(error)); }
		}
		try {
			const value = hooks[hook](JSON.parse(json), capability);
			if (typeof value?.then === "function") throw new TypeError(hook + " returned a Promise; only advance.run may be async.");
			return ok(value);
		} catch (error) { return fail(error); }
	};
	return [JSON.stringify({ declared, initial: box?.records?.initial }), dispatch];
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

/** @approved A guest failure as the host words it, naming the Box and the hook it stopped. */
const guestError = (id: BoxId, hook: string, { name, message }: SandboxedFailure) =>
	new Error(name === "InternalError" && message === "interrupted" ? `The ${id} Box's ${hook} ran past its ${SANDBOX_ENTRY_MS} ms limit.`
		: name === "InternalError" && message === "out of memory" ? `The ${id} Box's ${hook} ran out of its ${mebibytes(SANDBOX_HEAP_BYTES)} heap.`
		: `The ${id} Box's ${hook} threw ${name}: ${message}`);

const overLimit = (id: BoxId, hook: string, direction: "input" | "result") => new Error(`The ${id} Box's ${hook} ${direction} is over the ${mebibytes(SANDBOX_JSON_BYTES)} limit.`);

// @approved
//  A sandboxed Box: its `logic.js`, an ES module with no imports, evaluated in
// its own QuickJS runtime, behind the hooks the host calls on any Box. Hooks
// that receive no capability share one long-lived context. `read` receives
// `snapshot`, bound to the Chat it reads, so each read evaluates `logic.js`
// in a fresh context that is disposed when the read returns: no global keeps
// the capability for a later call. Each entry into the guest arms the
// interrupt deadline, and the byte limit refuses a call's JSON before the
// guest sees it and its reply before the host copies it. `dispose` frees the
// runtime once the registry drops it.
export const sandboxedBox = async (id: BoxId, source: string) => {
	const runtime = (await quickjs()).newRuntime();
	let deadline = 0;
	runtime.setInterruptHandler(() => performance.now() > deadline);
	const enter = () => { deadline = performance.now() + SANDBOX_ENTRY_MS; };

	/** @approved One guest context with `logic.js` evaluated in it, and the calls into its dispatcher. */
	const open = () => {
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
		// deadline, and returns its value's handle. With no host operation in
		// flight, a promise still pending once no job is left never settles.
		const settled = (hook: string, promise: QuickJSHandle): QuickJSHandle => {
			try {
				for (;;) {
					const state = vm.getPromiseState(promise);
					// @approved
					// A module without top-level await evaluates to its namespace, which reads as already fulfilled with the same handle.
					if (state.type === "fulfilled") return state.notAPromise === true ? promise.dup() : state.value;
					if (state.type === "rejected") throw guestError(id, hook, failure(state.error));
					enter();
					const jobs = runtime.executePendingJobs();
					if (jobs.error !== undefined) throw guestError(id, hook, failure(jobs.error));
					if (jobs.value === 0 && vm.getPromiseState(promise).type === "pending") throw new Error(`The ${id} Box's ${hook} never settled.`);
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
			//  One call into the dispatcher. A capability is a host function that
			// takes and returns a JSON string, each held to the byte limit.
			const call = (hook: string, json: string, capability?: (json: string) => string) => {
				if (Buffer.byteLength(json) > SANDBOX_JSON_BYTES) throw overLimit(id, hook, "input");
				const name = vm.newString(hook);
				const argument = vm.newString(json);
				const host = capability && vm.newFunction("snapshot", (query) => {
					const request = vm.getString(query);
					if (Buffer.byteLength(request) > SANDBOX_JSON_BYTES) throw overLimit(id, "snapshot", "input");
					const reply = capability(request);
					if (Buffer.byteLength(reply) > SANDBOX_JSON_BYTES) throw overLimit(id, "snapshot", "result");
					return vm.newString(reply);
				});
				enter();
				const result = vm.callFunction(enterHook, vm.undefined, name, argument, ...host === undefined ? [] : [host]);
				name.dispose();
				argument.dispose();
				host?.dispose();
				return unwrap(hook, result);
			};
			return { declaration, call, text, settled, dispose };
		} catch (error) {
			dispose();
			throw error;
		}
	};

	let shared: ReturnType<typeof open> | undefined;
	const dispose = () => {
		shared?.dispose();
		runtime.dispose();
	};
	try {
		shared = open();
		const { declaration, call, text, settled } = shared;
		if (declaration.declared.length === 0) throw new Error(`The ${id} Box's logic.js must default-export an object of hooks.`);
		const declared = new Map(declaration.declared.map(([key, kind]) => [key, kind] as const));
		const unsupported = [...declared.keys()].filter((key) => !supportedHooks.includes(key));
		if (unsupported.length > 0) throw new Error(`The ${id} Box's logic.js declares ${unsupported.join(", ")}, which a sandboxed Box cannot.`);
		const notFunctions = [...declared].filter(([key, kind]) => key !== "records.initial" && kind !== "function").map(([key]) => key);
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
		//  The window read: the guest's view and Status line, which it builds from
		// its setup, state and Cast, and its own stored values through
		// `snapshot`, and the Chat revision it read them at, which its commits
		// name as their snapshot.
		const read = ({ db, conversationId, summary, setup, state }: BoxWindowRead<Setup, State>) => {
			const input = {
				setup, state, human: summary.control.humanParticipantId,
				cast: summary.cast.map(({ id: participantId, name, portrait, sourceCharacterId, sourceCharacterName }) => ({
					id: participantId, name, portrait: portrait ?? null, character: sourceCharacterId === null ? null : { id: sourceCharacterId, name: sourceCharacterName },
				})),
			};
			const fresh = open();
			try {
				const output = outcome("read", fresh.text("read", fresh.call("read", JSON.stringify(input), boxSnapshot(db, id, conversationId))));
				assertChecked(sandboxedReadOutput, output, `The ${id} Box's read result`);
				return { snapshot: summary.revision, status: output.status ?? null, view: output.view };
			} finally { fresh.dispose(); }
		};
		const box = {
			...declared.has("setupError") && { setupError: (setup: Setup, previous: Setup) => sync("setupError", JSON.stringify([setup, previous])) },
			...declared.has("dependencies") && { dependencies: ({ seed, intent, cast }: Pick<CaptureRead, "seed" | "intent" | "cast">, setup: Setup) => sync("dependencies", JSON.stringify([{ seed, intent, cast }, setup])) },
			...declared.has("moves.render") && { moves: { render: (move: BoxValue, author: string) => sync("moves.render", JSON.stringify([move, author])) } },
			...(declared.has("records.initial") || declared.has("records.fold")) && { records: {
				...declared.has("records.initial") && { initial: declaration.initial },
				...declared.has("records.fold") && { fold: (state: State, record: GenerationJsonValue, setup: Setup) => foldAll(state, [record], setup), foldAll },
			} },
			...declared.has("advance.run") && { advance: {
				run: async ({ setup, dependencies, state, moves }: AdvanceInput<Setup, unknown, State, BoxValue>) =>
					outcome("advance.run", text("advance.run", settled("advance.run", call("advance.run", JSON.stringify({ setup, dependencies, state, moves }))))),
			} },
			...declared.has("read") && { read },
		};
		return { box, dispose };
	} catch (error) {
		dispose();
		throw error;
	}
};
