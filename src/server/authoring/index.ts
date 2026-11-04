import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { createFxAgent, memory, type FxAgent, type FxSession } from "libfx/node";
import { authoringFiles, authoringInstall, authoringPromptBody, CONTINUE_STEPS, authoringSessionParams, authoringStart, authoringStartBody, authoringStepsBody } from "../../shared/contract/authoring";
import type { AuthoringEvent, AuthoringSteps, CodingModel, ScenarioResult } from "../../shared/contract/authoring";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { createConnectionSettingsModule } from "../connection-settings";
import { boxFolders } from "../box/registry";
import { notFoundResponse } from "../contract/responses";
import { createCandidate, defaultAuthoringFolder, sweepCandidates, type Candidate } from "./candidate";
import { reasoningEntry, shown, toolInput } from "./activity";
import { installCandidate } from "./install";
import { libfxProvider } from "./provider";
import { authoringTools } from "./tools";

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

/** @approved One open authoring panel: its candidate, its libfx agent and session, the turn that is running, what its message has cost, and each scenario result not yet streamed. */
type Session = { readonly candidate: Candidate; readonly agent: FxAgent; readonly fx: FxSession; running: boolean; readonly budget: Budget; readonly scenarios: Map<string, ScenarioResult> };

/** @approved Settles with `promise`, or rejects once `signal` aborts first, so a cancelled turn never waits on a pause. */
const unlessAborted = (promise: Promise<void>, signal: AbortSignal | null | undefined) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted === true) return reject(signal.reason);
	const abort = () => reject(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	void promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
});

// @approved
//  Creator Mode's authoring sessions, in memory: one per open panel, each an
// embedded libfx agent on the writer's chosen coding model, whose only tools
// write and check one candidate. Closing the panel, or the server stopping,
// ends its session and removes its candidate; candidates a stopped server
// left behind are swept when the app starts. Turns stream the agent's events
// as NDJSON. Install is a separate writer action, never an agent tool, and
// nothing an authoring session says becomes a story Message or Memory.
export const createAuthoring = (database: Database, folders: AuthoringFolders = defaultAuthoringFolders()) => {
	const sessions = new Map<string, Session>();
	const close = async (id: string) => {
		const session = sessions.get(id);
		if (session === undefined) return;
		sessions.delete(id);
		await session.fx.cancel().catch(() => undefined);
		await session.agent.close().catch(() => undefined);
		await session.candidate.remove();
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
	const start = async ({ steps, ...choice }: CodingModel & { readonly steps: AuthoringSteps }) => {
		const refused = (reason: string) => ({ outcome: "refused", reason } as const);
		const connections = createConnectionSettingsModule(database);
		const profile = connections.get().profiles.find(({ id }) => id === choice.profileId);
		if (profile === undefined) return refused("That connection no longer exists.");
		let secrets: ReturnType<typeof connections.getProfileSecrets>;
		try { secrets = connections.getProfileSecrets(profile.id); } catch (error) { return refused(`${profile.displayName}'s saved credentials cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
		const mapped = libfxProvider(profile, secrets, choice);
		if (mapped.outcome === "refused") return mapped;
		const candidate = await createCandidate(folders.root);
		const scenarios = new Map<string, ScenarioResult>();
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
		const send = mapped.options.fetch;
		// @approved
		//  The Wasm backend, chosen explicitly: it runs wherever Bun does, the
		// Docker image's architectures and Windows included, where the native
		// addon ships for four platforms only.
		const agent = createFxAgent({
			backend: "wasm", durability: memory(), name: "creator", instructions: instructions(candidate.id),
			tools: authoringTools(candidate, { spend: (signal) => spend("tool calls", signal), onScenario: (call, result) => scenarios.set(call, result) }),
			...mapped.options, fetch: async (input: string, init: RequestInit) => {
				await spend("model requests", init.signal);
				return await send(input, init);
			},
		});
		const fx = agent.session();
		sessions.set(candidate.session, { candidate, agent, fx, running: false, budget, scenarios });
		return { outcome: "started", session: candidate.session, candidate: candidate.id } as const;
	};
	const prompt = (session: Session, text: string) => {
		const encoder = new TextEncoder();
		session.running = true;
		let open = true;
		let send = (_: AuthoringEvent) => {};
		Object.assign(session.budget, { limit: session.budget.steps, "model requests": 0, "tool calls": 0, spent: null, pause: null, paused: (steps: number) => send({ type: "paused", steps }) });
		const turn = session.fx.prompt(text);
		const reasoning = reasoningEntry();
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		return new ReadableStream<Uint8Array>({
			async start(controller) {
				send = (event) => { if (open) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
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
					session.running = false;
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
	const routes = new Elysia()
		.post("/api/authoring/sessions", ({ body }) => start(body), { body: authoringStartBody, response: authoringStart })
		.post("/api/authoring/sessions/:session/prompts", ({ params, body, status }) => {
			const session = sessions.get(params.session);
			if (session === undefined) return notFoundResponse();
			if (session.running) return status(409, { outcome: "refused", reason: "A turn is still running." } as const);
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
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams, body: authoringStepsBody })
		.delete("/api/authoring/sessions/:session", async ({ params }) => {
			await close(params.session);
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
			return await installCandidate(database, session.candidate, folders.plugins);
		}, { params: authoringSessionParams, response: { 200: authoringInstall, 404: notFoundOutcome } });
	return {
		routes,
		sweep: () => sweepCandidates(folders.root),
		close: () => Promise.all([...sessions.keys()].map(close)),
	};
};
