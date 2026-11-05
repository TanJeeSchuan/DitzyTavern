import type { Database } from "bun:sqlite";
import { appendFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { Elysia } from "elysia";
import { createFxAgent, memory, type FxAgent, type FxSession } from "libfx/node";
import { authoredLabel, authoringFiles, authoringInstall, authoringLogEntry, authoringMeta, authoringPromptBody, authoringSessions, CONTINUE_STEPS } from "../../shared/contract/authoring";
import { authoringSessionParams, authoringStart, authoringStartBody, authoringStepsBody } from "../../shared/contract/authoring";
import type { AuthoringEvent, AuthoringLogEntry, AuthoringMeta, AuthoringSteps, CodingModel, ScenarioResult } from "../../shared/contract/authoring";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { createConnectionSettingsModule } from "../connection-settings";
import { boxFolders, serverBoxes } from "../box/registry";
import { replaceFile } from "../box/sandboxed-folder";
import { notFoundResponse } from "../contract/responses";
import { createCandidate, defaultAuthoringFolder, SESSION_META, sweepCandidates, type Candidate } from "./candidate";
import { reasoningEntry, shown, toolInput } from "./activity";
import { installCandidate } from "./install";
import { libfxProvider } from "./provider";
import { authoringTools, checkScenario } from "./tools";

/** @approved Where candidates are made, and the plugin folder Install publishes into. */
export type AuthoringFolders = { readonly root: string; readonly plugins: string };
export const defaultAuthoringFolders = (): AuthoringFolders => ({ root: defaultAuthoringFolder(), plugins: boxFolders[1]! }); // @approved boxFolders lists the built-in folder, then the plugin folder.

const instructions = (id: string) => [
	"You write sandboxed Boxes for DitzyTavern, an app for writing stories with a model, by calling your tools. You have no other tools, files or network.",
	`Your Box's id is ${id}; the host sets it in descriptor.json. Read the contract with read_contract before you write anything.`,
	"Write descriptor.json, logic.js and, unless the Box's window is the passage timeline, ui.js, then run a scenario with run_scenario after every change and fix every diagnostic.",
	"When something about the mechanic is unclear, ask the writer in your reply. When a scenario passes, say what the Box does and that the writer can install it. Installing is the writer's action, never yours.",
];

/** @approved How often a turn's stream sends a blank line, well inside the server's 30-second idle timeout. */
export const AUTHORING_HEARTBEAT_MS = 5_000;

export const budgetSpent = (steps: number) => `The agent stopped after ${steps} steps on this message. Send another message to let it continue.`;
type Spending = "model requests" | "tool calls";

// @approved
//  What one writer message has cost: its model requests and tool calls, each
// counted against `limit`, which starts at the session's `steps` and grows by
// each Continue. While a request or call waits past the limit, `pause` holds
// it; Continue resolves it, and Stop or closing rejects it. `spent` is the
// reason a stopped message gives.
type Budget = { steps: AuthoringSteps; limit: number | null; "model requests": number; "tool calls": number; spent: string | null; pause: PromiseWithResolvers<void> | null; paused: (steps: number) => void };

// @approved
//  One open authoring panel: its candidate, its libfx agent and session, the
// turn that is running and the promise it settles once ended, what its
// message has cost, each scenario result not yet streamed, its saved meta,
// and the chain its folder's writes take in order.
type Session = {
	readonly candidate: Candidate; readonly agent: FxAgent; readonly fx: FxSession; running: boolean; turn: Promise<void> | null;
	readonly budget: Budget; readonly scenarios: Map<string, ScenarioResult>; meta: AuthoringMeta; saving: Promise<void>;
};
const CHECKPOINT = "checkpoint.bin";
const LOG = "log.ndjson";

/** @approved Settles with `promise`, or rejects once `signal` aborts first, so a cancelled turn never waits on a pause. */
const unlessAborted = (promise: Promise<void>, signal: AbortSignal | null | undefined) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted === true) return reject(signal.reason);
	const abort = () => reject(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	void promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
});

// @approved
//  Creator Mode's authoring sessions: each an embedded libfx agent on the
// writer's chosen coding model, whose only tools write and check one
// candidate. A session is saved as files in `<root>/<session>/`: meta.json,
// the libfx checkpoint after each turn, the log of what the panel was
// streamed, and the candidate. An open panel holds its session in memory;
// closing the panel, or the server stopping, releases it, and opening it
// again restores the agent from its checkpoint. Only Discard removes the
// folder. A session links to the Box it installed only by id, so either can
// go without breaking the other. Install is a separate writer action, never
// an agent tool, and nothing an authoring session says becomes a story
// Message or Memory.
export const createAuthoring = (database: Database, folders: AuthoringFolders = defaultAuthoringFolders()) => {
	const sessions = new Map<string, Session>();
	const folderOf = (session: string) => join(folders.root, session);
	const now = () => new Date().toISOString();
	const readMeta = async (session: string) => {
		try {
			const meta: unknown = JSON.parse(await Bun.file(join(folderOf(session), SESSION_META)).text());
			return Value.Check(authoringMeta, meta) ? meta : undefined;
		} catch { return undefined; }
	};
	const writeMeta = (session: string, meta: AuthoringMeta) => replaceFile(join(folderOf(session), SESSION_META), JSON.stringify(meta));
	/** @approved Queues a write to the session's folder behind the ones before it, so its log keeps its order; a failed write is reported, never thrown into the turn. */
	const save = (session: Session, write: () => Promise<void>) => {
		session.saving = session.saving.then(write).then(() => undefined, (error: Error) => console.error(`Authoring session ${session.candidate.session} was not saved: ${error.message}`));
	};
	const record = (session: Session, entry: AuthoringLogEntry) => save(session, () => appendFile(join(folderOf(session.candidate.session), LOG), `${JSON.stringify(entry)}\n`));
	// @approved
	//  Releasing a session cancels its turn, waits for it to end and for its
	// checkpoint and log to be written, then closes its agent. Its folder
	// stays, unless the writer never sent it a message: a session started and
	// left at once is not worth listing.
	const release = async (id: string) => {
		const session = sessions.get(id);
		if (session === undefined) return;
		sessions.delete(id);
		await session.fx.cancel().catch(() => undefined);
		await session.turn;
		await session.saving;
		await session.agent.close().catch(() => undefined);
		if (!await Bun.file(join(folderOf(id), LOG)).exists()) await rm(folderOf(id), { recursive: true, force: true });
	};
	const discard = async (id: string) => {
		await release(id);
		await rm(folderOf(id), { recursive: true, force: true });
	};
	const list = async () => {
		const ids = await readdir(folders.root).catch(() => []);
		const saved = await Promise.all(ids.map(async (session) => {
			const meta = await readMeta(session);
			if (meta === undefined) return [];
			const descriptor: unknown = await Bun.file(join(folderOf(session), meta.box, "descriptor.json")).json().catch(() => undefined);
			const label = Value.Check(authoredLabel, descriptor) ? descriptor.label : null;
			return [{ session, ...meta, installed: meta.installed && serverBoxes().has(meta.box), label }];
		}));
		return { sessions: saved.flat().sort((a, b) => b.updated.localeCompare(a.updated)) };
	};
	// @approved
	//  Stopping a paused message ends it for its budget, with the reason the
	// panel shows; stopping a running one cancels it.
	const stop = (session: Session) => {
		const { budget } = session;
		if (budget.pause !== null && budget.limit !== null) {
			budget.spent = budgetSpent(budget.limit);
			budget.pause.reject(new Error(budget.spent));
			budget.pause = null;
		}
		return session.fx.cancel();
	};
	/** @approved Continue: the paused message may take more steps, and whatever waited goes on. */
	const grant = ({ budget }: Session) => {
		if (budget.pause === null || budget.limit === null) return;
		budget.limit += CONTINUE_STEPS;
		budget.pause.resolve();
		budget.pause = null;
	};
	const refused = (reason: string) => ({ outcome: "refused", reason } as const);
	const connect = (choice: CodingModel) => {
		const connections = createConnectionSettingsModule(database);
		const profile = connections.get().profiles.find(({ id }) => id === choice.profileId);
		if (profile === undefined) return refused("That connection no longer exists.");
		let secrets: ReturnType<typeof connections.getProfileSecrets>;
		try { secrets = connections.getProfileSecrets(profile.id); } catch (error) { return refused(`${profile.displayName}'s saved credentials cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
		return libfxProvider(profile, secrets, choice);
	};
	const boot = (candidate: Candidate, meta: AuthoringMeta, options: Extract<ReturnType<typeof libfxProvider>, { outcome: "mapped" }>["options"], checkpoint?: Uint8Array) => {
		const { steps } = meta;
		const scenarios = new Map<string, ScenarioResult>();
		let session: Session | undefined;
		const budget: Budget = { steps, limit: steps, "model requests": 0, "tool calls": 0, spent: null, pause: null, paused: () => {} };
		// @approved
		//  A model that never stops would spend without end, so each writer
		// message takes a number of steps: each model request and each tool
		// call counts against it. The next one past it waits, and the panel
		// asks the writer to continue or stop; without a limit nothing waits.
		const spend = async (kind: Spending, signal: AbortSignal | null | undefined) => {
			budget[kind] += 1;
			for (;;) {
				if (budget.spent !== null) throw new Error(budget.spent);
				if (budget.limit === null || budget[kind] <= budget.limit) return;
				if (budget.pause === null) {
					budget.pause = Promise.withResolvers<void>();
					budget.paused(budget.limit);
				}
				await unlessAborted(budget.pause.promise, signal);
			}
		};
		const send = options.fetch;
		// @approved
		//  The Wasm backend, chosen explicitly: it runs wherever Bun does, the
		// Docker image's architectures and Windows included, where the native
		// addon ships for four platforms only.
		const agent = createFxAgent({
			backend: "wasm", durability: memory(), name: "creator", instructions: instructions(candidate.id), ...checkpoint !== undefined && { checkpoint },
			tools: authoringTools(candidate, folders.plugins, { spend: (signal) => spend("tool calls", signal), onScenario: (call, input, result) => {
				scenarios.set(call, result);
				if (session !== undefined) record(session, { type: "scenario-input", id: call, input });
			} }),
			...options, fetch: async (input: string, init: RequestInit) => {
				await spend("model requests", init.signal);
				return await send(input, init);
			},
		});
		const fx = agent.session();
		session = { candidate, agent, fx, running: false, turn: null, budget, scenarios, meta, saving: Promise.resolve() };
		sessions.set(candidate.session, session);
	};
	const start = async ({ steps, ...choice }: CodingModel & { readonly steps: AuthoringSteps }) => {
		const mapped = connect(choice);
		if (mapped.outcome === "refused") return mapped;
		const candidate = await createCandidate(folders.root);
		const meta = { box: candidate.id, ...choice, steps, installed: false, updated: now() };
		await writeMeta(candidate.session, meta);
		boot(candidate, meta, mapped.options);
		return { outcome: "started", session: candidate.session, candidate: candidate.id } as const;
	};
	// @approved
	//  Opens a saved session on the coding model the writer chose now, from its
	// checkpoint when a turn ever ended. A session another panel holds is
	// released first, so the last panel to open it has it, and its meta is
	// read only after, since an Install as a new Box it was running may have
	// changed the Box id.
	const open = async (id: string, { steps, ...choice }: CodingModel & { readonly steps: AuthoringSteps }) => {
		const mapped = connect(choice);
		if (mapped.outcome === "refused") return mapped;
		await release(id);
		const saved = await readMeta(id);
		if (saved === undefined) return refused("That session no longer exists.");
		const file = Bun.file(join(folderOf(id), CHECKPOINT));
		const checkpoint = await file.exists() ? new Uint8Array(await file.arrayBuffer()) : undefined;
		const meta = { ...saved, ...choice, steps, updated: now() };
		const candidate = await createCandidate(folders.root, { session: id, id: saved.box });
		try {
			boot(candidate, meta, mapped.options, checkpoint);
		} catch (error) {
			return refused(`This session cannot be reopened (${error instanceof Error ? error.message : String(error)}). Discard it to start over.`);
		}
		await writeMeta(id, meta);
		return { outcome: "started", session: id, candidate: saved.box } as const;
	};
	const prompt = (session: Session, text: string) => {
		const encoder = new TextEncoder();
		session.running = true;
		const ended = Promise.withResolvers<void>();
		session.turn = ended.promise;
		record(session, { type: "prompt", text });
		let open = true;
		let send = (_: AuthoringEvent) => {};
		Object.assign(session.budget, { limit: session.budget.steps, "model requests": 0, "tool calls": 0, spent: null, pause: null, paused: (steps: number) => send({ type: "paused", steps }) });
		const turn = session.fx.prompt(text);
		const reasoning = reasoningEntry();
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		return new ReadableStream<Uint8Array>({
			async start(controller) {
				send = (event) => {
					record(session, event);
					if (open) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				};
				// @approved
				//  A turn can sit paused on its steps, or wait on a slow provider,
				// longer than the server's idle timeout, which would close the
				// stream and so cancel the turn. A blank line, which the panel
				// skips, keeps it open, as the change and update streams do.
				heartbeat = setInterval(() => { if (open) controller.enqueue(encoder.encode("\n")); }, AUTHORING_HEARTBEAT_MS);
				try {
					for await (const event of turn) {
						if (event.type === "tool_start" || event.type === "tool_end") reasoning.reset();
						if (event.type === "text_delta") send({ type: "text", delta: event.delta });
						else if (event.type === "reasoning_delta") {
							const part = reasoning.next(event.delta);
							if (part !== undefined) send({ type: "reasoning", delta: part.text, truncated: part.truncated });
						}
						else if (event.type === "tool_start") {
							const { text, truncated } = toolInput(event);
							send({ type: "tool", id: event.id, name: event.name, input: text, truncated });
						} else if (event.type === "tool_end") {
							const { text, truncated } = shown(event.content ?? "");
							send({ type: "tool-end", id: event.id, name: event.name, isError: event.isError, content: text, truncated });
							const result = session.scenarios.get(event.id);
							session.scenarios.delete(event.id);
							if (result !== undefined) send({ type: "scenario", id: event.id, result });
						}
					}
					const { stopReason, error } = await turn.result;
					send(session.budget.spent !== null ? { type: "end", stopReason: "budget", error: session.budget.spent } : { type: "end", stopReason, ...error !== undefined && { error: error.message } });
				} catch (error) {
					send({ type: "end", stopReason: "error", error: error instanceof Error ? error.message : String(error) });
				} finally {
					clearInterval(heartbeat);
					save(session, async () => {
						await replaceFile(join(folderOf(session.candidate.session), CHECKPOINT), await session.fx.checkpoint());
						session.meta = { ...session.meta, updated: now() };
						await writeMeta(session.candidate.session, session.meta);
					});
					session.running = false;
					session.turn = null;
					ended.resolve();
					if (open) controller.close();
				}
			},
			cancel() {
				clearInterval(heartbeat);
				open = false;
				void stop(session);
			},
		});
	};
	/** @approved Every scenario the session's agent ran, whole, from its log, oldest first. */
	const savedScenarios = async (session: Session) => {
		await session.saving;
		const log = await Bun.file(join(folderOf(session.candidate.session), LOG)).text().catch(() => "");
		return log.split("\n").flatMap((line) => {
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { return []; }
			return Value.Check(authoringLogEntry, entry) && entry.type === "scenario-input" ? [entry.input] : [];
		});
	};
	// @approved
	//  Install, and Install as a new Box, run with the session to themselves:
	// a scenario a running turn has yet to log would be missing from the saved
	// scenarios Install replays, and a renewed id would move the folder under
	// its writes. So neither starts while a turn runs, and each holds
	// `running` until it ends, which refuses a new message, a steps change or
	// another Install meanwhile. It is the session's `turn` too, so closing,
	// reopening, discarding or stopping the session waits for it to end.
	const running = () => ({ outcome: "refused" as const, reason: "Wait for the message to finish.", diagnostics: [] });
	const alone = async <T>(session: Session, action: () => Promise<T>) => {
		const ended = Promise.withResolvers<void>();
		session.running = true;
		session.turn = ended.promise;
		try { return await action(); } finally {
			session.running = false;
			session.turn = null;
			ended.resolve();
		}
	};
	const install = async (session: Session) => {
		const installed = await installCandidate(session.candidate, folders.plugins, await savedScenarios(session));
		if (installed.outcome === "installed") {
			session.meta = { ...session.meta, installed: true, updated: now() };
			save(session, () => writeMeta(session.candidate.session, session.meta));
		}
		return installed;
	};
	const routes = new Elysia()
		.get("/api/authoring/sessions", () => list(), { response: authoringSessions })
		.post("/api/authoring/sessions", ({ body }) => start(body), { body: authoringStartBody, response: authoringStart })
		.post("/api/authoring/sessions/:session/open", ({ params, body }) => open(params.session, body), { params: authoringSessionParams, body: authoringStartBody, response: authoringStart })
		.get("/api/authoring/sessions/:session/log", async ({ params }) => {
			await sessions.get(params.session)?.saving;
			const log = Bun.file(join(folderOf(params.session), LOG));
			return new Response(await log.exists() ? log : "", { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
		}, { params: authoringSessionParams })
		.post("/api/authoring/sessions/:session/close", async ({ params }) => {
			await release(params.session);
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams })
		.post("/api/authoring/sessions/:session/prompts", ({ params, body, status }) => {
			const session = sessions.get(params.session);
			if (session === undefined) return notFoundResponse();
			if (session.running) return status(409, { outcome: "refused", reason: "A turn or an Install is still running." } as const);
			return new Response(prompt(session, body.text), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
		}, { params: authoringSessionParams, body: authoringPromptBody })
		.post("/api/authoring/sessions/:session/cancel", async ({ params }) => {
			const session = sessions.get(params.session);
			if (session !== undefined) await stop(session);
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams })
		.post("/api/authoring/sessions/:session/continue", ({ params }) => {
			const session = sessions.get(params.session);
			if (session !== undefined) grant(session);
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams })
		.put("/api/authoring/sessions/:session/steps", ({ params, body, status }) => {
			const session = sessions.get(params.session);
			if (session === undefined) return notFoundResponse();
			if (session.running) return status(409, { outcome: "refused", reason: "Steps per message change between turns, not during one." } as const);
			session.budget.steps = body.steps;
			session.meta = { ...session.meta, steps: body.steps };
			save(session, () => writeMeta(params.session, session.meta));
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams, body: authoringStepsBody })
		.delete("/api/authoring/sessions/:session", async ({ params }) => {
			await discard(params.session);
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams })
		.get("/api/authoring/sessions/:session/files", async ({ params }) => {
			const session = sessions.get(params.session);
			if (session === undefined) return notFoundResponse();
			return { files: await session.candidate.files() };
		}, { params: authoringSessionParams, response: { 200: authoringFiles, 404: notFoundOutcome } })
		.post("/api/authoring/sessions/:session/install", async ({ params }) => {
			const session = sessions.get(params.session);
			if (session === undefined) return notFoundResponse();
			if (session.running) return running();
			return await alone(session, () => install(session));
		}, { params: authoringSessionParams, response: { 200: authoringInstall, 404: notFoundOutcome } })
		// @approved
		//  Install as a new Box: the session's candidate takes a new id, so
		// Chats holding the Box it installed keep that Box, and its saved meta
		// follows. A new id makes a new version hash, which no scenario passed
		// on yet, so the session's latest saved scenario runs again on it,
		// without its `from`, before the Install that creates the new Box.
		.post("/api/authoring/sessions/:session/new-box", async ({ params }) => {
			const session = sessions.get(params.session);
			if (session === undefined) return notFoundResponse();
			if (session.running) return running();
			return await alone(session, async () => {
				const { candidate } = session;
				await candidate.renew();
				session.meta = { ...session.meta, box: candidate.id, installed: false, updated: now() };
				save(session, () => writeMeta(params.session, session.meta));
				const latest = (await savedScenarios(session)).at(-1);
				if (latest !== undefined) await candidate.check(() => checkScenario(candidate, folders.plugins, { ...latest, from: undefined }, new AbortController().signal));
				return await install(session);
			});
		}, { params: authoringSessionParams, response: { 200: authoringInstall, 404: notFoundOutcome } });
	return {
		routes,
		sweep: () => sweepCandidates(folders.root),
		close: () => Promise.all([...sessions.keys()].map(release)),
	};
};
