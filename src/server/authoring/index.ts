import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { createFxAgent, memory, type FxAgent, type FxSession } from "libfx/node";
import { authoringInstall, authoringPromptBody, authoringSessionParams, authoringStart, codingModel } from "../../shared/contract/authoring";
import type { AuthoringEvent, CodingModel, ScenarioResult } from "../../shared/contract/authoring";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { createConnectionSettingsModule } from "../connection-settings";
import { boxFolders } from "../box/registry";
import { notFoundResponse } from "../contract/responses";
import { createCandidate, defaultAuthoringFolder, sweepCandidates, type Candidate } from "./candidate";
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

/** @approved The most model requests and tool calls one writer message may cost. Requests are counted where they leave for the provider, so a model looping on tools it does not have, or on text, is held to the same limit. */
export const PER_MESSAGE = { "model requests": 40, "tool calls": 40 } as const;
type Spending = keyof typeof PER_MESSAGE;
export const budgetSpent = (kind: Spending) => `The agent used the ${PER_MESSAGE[kind]} ${kind} one message allows, so its turn stopped. Send another message to let it continue.`;

/** @approved One open authoring panel: its candidate, its libfx agent and session, the turn that is running, what its message has cost, and each scenario result not yet streamed. */
type Session = { readonly candidate: Candidate; readonly agent: FxAgent; readonly fx: FxSession; running: boolean; readonly budget: Record<Spending, number> & { spent: string | null }; readonly scenarios: Map<string, ScenarioResult> };

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
	const start = async (choice: CodingModel) => {
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
		const budget: Session["budget"] = { "model requests": 0, "tool calls": 0, spent: null };
		// @approved
		//  A model that never stops would spend without end, so each writer
		// message buys a fixed number of model requests and tool calls; the
		// next one past either cancels the turn and fails, and the turn ends
		// saying why.
		const spend = (kind: Spending) => {
			if (++budget[kind] <= PER_MESSAGE[kind]) return;
			budget.spent ??= budgetSpent(kind);
			void fx.cancel();
			throw new Error(budget.spent);
		};
		const send = mapped.options.fetch;
		// @approved
		//  The Wasm backend, chosen explicitly: it runs wherever Bun does, the
		// Docker image's architectures and Windows included, where the native
		// addon ships for four platforms only.
		const agent = createFxAgent({
			backend: "wasm", durability: memory(), name: "creator", instructions: instructions(candidate.id),
			tools: authoringTools(candidate, { spend: () => spend("tool calls"), onScenario: (call, result) => scenarios.set(call, result) }),
			...mapped.options, fetch: (input: string, init: RequestInit) => { spend("model requests"); return send(input, init); },
		});
		const fx = agent.session();
		sessions.set(candidate.session, { candidate, agent, fx, running: false, budget, scenarios });
		return { outcome: "started", session: candidate.session, candidate: candidate.id } as const;
	};
	const prompt = (session: Session, text: string) => {
		const encoder = new TextEncoder();
		session.running = true;
		Object.assign(session.budget, { "model requests": 0, "tool calls": 0, spent: null });
		const turn = session.fx.prompt(text);
		let open = true;
		return new ReadableStream<Uint8Array>({
			async start(controller) {
				const send = (event: AuthoringEvent) => { if (open) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
				try {
					for await (const event of turn) {
						if (event.type === "text_delta") send({ type: "text", delta: event.delta });
						else if (event.type === "tool_start") send({ type: "tool", id: event.id, name: event.name });
						else if (event.type === "tool_end") {
							send({ type: "tool-end", id: event.id, name: event.name, isError: event.isError, content: event.content ?? "" });
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
					session.running = false;
					if (open) controller.close();
				}
			},
			cancel() {
				open = false;
				void session.fx.cancel();
			},
		});
	};
	const routes = new Elysia()
		.post("/api/authoring/sessions", ({ body }) => start(body), { body: codingModel, response: authoringStart })
		.post("/api/authoring/sessions/:session/prompts", ({ params, body, status }) => {
			const session = sessions.get(params.session);
			if (session === undefined) return notFoundResponse();
			if (session.running) return status(409, { outcome: "refused", reason: "A turn is still running." } as const);
			return new Response(prompt(session, body.text), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
		}, { params: authoringSessionParams, body: authoringPromptBody })
		.post("/api/authoring/sessions/:session/cancel", async ({ params }) => {
			await sessions.get(params.session)?.fx.cancel();
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams })
		.delete("/api/authoring/sessions/:session", async ({ params }) => {
			await close(params.session);
			return new Response(null, { status: 204 });
		}, { params: authoringSessionParams })
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
