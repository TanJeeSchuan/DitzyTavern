import { afterEach, describe, expect, test } from "bun:test";
import type { ConversationGenerationSettings, ConversationSummary } from "../shared/contract/conversation-schema";
import type { BudgetValues, SamplingValues } from "./generation-settings-draft";

// The client/client divergence regression: the composer's model selector and
// the Generation panel are two live editors of one Conversation's Generation
// Settings. Both used to own complete snapshots that they reloaded only when
// the Conversation ID changed, so committing one editor's change restored the
// other editor's stale fields with a valid newer revision. The seam under
// test is each editor's command path: the selector may send only the focused
// model-selection command, and the panel's full write must read its base at
// write time. The fake transport records exactly what each editor sends; the
// server-side merge semantics for the focused command are proven against a
// real database in src/server/conversation/set-generation-model.test.ts.

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { commitConversationModel } = await import("./model-selection-command");
const { saveGenerationSettingsDraft } = await import("./workspace/useGenerationSettingsDraft");

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const installFetch = (handler: FetchHandler): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const summary = (revision: number): ConversationSummary => ({
	id: 1,
	name: "Seaside Letters",
	revision,
	cast: [],
	control: { humanParticipantId: null, modelParticipantId: null },
	controlValidity: { valid: false, reason: "missing-seat" },
	playable: false,
	capabilities: {
		compose: { available: false, reason: "conversation-not-playable" },
		generate: { available: false, reason: "conversation-not-playable" },
		swipe: { available: false, reason: "conversation-not-playable" },
	},
	activeGenerations: [],
});

const baseSettings = (): ConversationGenerationSettings => ({
	modelId: "deepseek-chat",
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 32768,
	responseBudget: 1024,
	safetyAllowance: 500,
	siblingGenerationLimit: 4,
	continuationStrategy: "instruction",
	continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
	continuationPrefillSuffix: "",
	requestOverrides: { "chat-completions": {}, responses: {}, "anthropic-messages": {} },
});

const sampling = (overrides: Partial<SamplingValues> = {}): SamplingValues => ({
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	...overrides,
});

const budget = (overrides: Partial<BudgetValues> = {}): BudgetValues => ({
	contextLimit: 32768,
	responseBudget: 1024,
	safetyAllowance: 500,
	siblingGenerationLimit: 4,
	...overrides,
});

const overrides = (): ConversationGenerationSettings["requestOverrides"] => ({
	"chat-completions": {},
	responses: {},
	"anthropic-messages": {},
});

// A minimal Conversation command transport: the stored settings and revision
// live server-side, the Generation Settings read serves them, and each
// applied command bumps the revision exactly like the real Conversation
// module. The focused model command merges its model ID into the stored
// settings server-side — the behavior the focused command exists for.
function createConversationBackend() {
	let revision = 5;
	let settings = baseSettings();
	const commands: unknown[] = [];

	const handler: FetchHandler = async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const method = init?.method ?? "GET";
		if (method === "GET" && url.endsWith("/api/conversations/1/generation-settings")) {
			return Response.json(settings);
		}
		if (method === "POST" && url.endsWith("/api/conversations/1/commands")) {
			// SAFETY: the test's own command posts serialize the typed command
			// body to JSON, so parsing the recorded body restores that shape.
			const body = JSON.parse(String(init?.body)) as {
				expectedRevision: number;
				action: { type: string; modelId?: string; settings?: ConversationGenerationSettings };
			};
			if (body.expectedRevision !== revision) {
				return Response.json(
					{ outcome: "conflict", currentConversation: summary(revision) },
					{ status: 409 },
				);
			}
			commands.push(body.action);
			if (body.action.type === "update-generation-settings" && body.action.settings !== undefined) {
				settings = body.action.settings;
			}
			if (body.action.type === "set-generation-model" && body.action.modelId !== undefined) {
				settings = { ...settings, modelId: body.action.modelId };
			}
			revision += 1;
			return Response.json({ outcome: "applied", conversation: summary(revision) });
		}
		return new Response(null, { status: 404 });
	};

	return {
		handler,
		commands,
		current: (): ConversationGenerationSettings => settings,
		currentRevision: (): number => revision,
	};
}

// The two editors observe the shared Conversation snapshot: an applied
// command adopts the authoritative summary exactly like the workspace's
// Conversation state owner does, so the next editor's command is based on
// the newer revision.
function createSession() {
	const events: string[] = [];
	let conversation = summary(5);
	const adoptSnapshot = (adopted: ConversationSummary) => {
		events.push(`adopt:${adopted.revision}`);
		conversation = adopted;
	};
	const showError = (message: string) => {
		events.push(`error:${message}`);
	};
	// The panel's local draft state persists across saves exactly like the
	// hook's state: each save sends the whole draft, not just the last edit.
	let panelSampling = sampling();
	let panelBudget = budget();
	const savePanelDraft = async (edits: {
		sampling?: Partial<SamplingValues>;
		budget?: Partial<BudgetValues>;
	}) => {
		if (edits.sampling !== undefined) panelSampling = { ...panelSampling, ...edits.sampling };
		if (edits.budget !== undefined) panelBudget = { ...panelBudget, ...edits.budget };
		await saveGenerationSettingsDraft({
			conversation,
			drafts: {
				sampling: panelSampling,
				budget: panelBudget,
				overrides: overrides(),
				strategy: "instruction",
				instruction: "Continue the narrative.",
				prefillSuffix: "",
			},
			reconciliation: { adoptSnapshot, showNotice: showError },
			onApplied: () => {
				events.push("panel-applied");
			},
			onNotPlayable: showError,
			onNotRemovable: showError,
		});
	};
	const commitModel = async (modelId: string) => {
		await commitConversationModel({
			conversation,
			modelId,
			reconciliation: { adoptSnapshot, showNotice: showError },
			onCommitted: (committed) => {
				events.push(`model-committed:${committed}`);
			},
			onUnavailable: showError,
		});
	};
	return { events, savePanelDraft, commitModel, conversation: () => conversation };
}

describe("generation settings client ownership", () => {
	test("the model selector's commit sends only the focused model command", async () => {
		const backend = createConversationBackend();
		installFetch(backend.handler);
		const session = createSession();

		await session.commitModel("qwen3-max");

		// The payload carries the model ID and nothing else: the selector has
		// no settings snapshot to spill into the command.
		expect(backend.commands).toEqual([{ type: "set-generation-model", modelId: "qwen3-max" }]);
		expect(session.events).toEqual(["adopt:6", "model-committed:qwen3-max"]);
	});

	test("two editors committing one after the other never restore each other's fields", async () => {
		const backend = createConversationBackend();
		installFetch(backend.handler);
		const session = createSession();

		// Editor A — the Generation panel: one Sampling edit, applied.
		await session.savePanelDraft({ sampling: { temperature: 1.5 } });

		// Editor B — the composer's model selector: one model commit, applied.
		await session.commitModel("qwen3-max");

		// Editor A again — one Budget edit, applied after the model change.
		await session.savePanelDraft({ budget: { contextLimit: 4096 } });

		// The panel's full write starts from the authoritative settings read at
		// write time, so the first write carries the loaded model while the
		// second carries the selector's committed model — never a stale one.
		// SAFETY: the recorded commands are only the two action types this test
		// sends, in order, and each carries the shape asserted here.
		const [firstPanelWrite, modelCommit, secondPanelWrite] = backend.commands as [
			{ type: string; settings: ConversationGenerationSettings },
			{ type: string; modelId: string },
			{ type: string; settings: ConversationGenerationSettings },
		];
		expect(firstPanelWrite.type).toBe("update-generation-settings");
		expect(firstPanelWrite.settings.modelId).toBe("deepseek-chat");
		expect(firstPanelWrite.settings.temperature).toBe(1.5);
		expect(modelCommit).toEqual({ type: "set-generation-model", modelId: "qwen3-max" });
		expect(secondPanelWrite.type).toBe("update-generation-settings");
		expect(secondPanelWrite.settings.modelId).toBe("qwen3-max");
		expect(secondPanelWrite.settings.temperature).toBe(1.5);
		expect(secondPanelWrite.settings.contextLimit).toBe(4096);

		// The stored aggregate keeps every editor's change: no stale-field
		// restore happened anywhere in the sequence.
		const stored = backend.current();
		expect(stored.modelId).toBe("qwen3-max");
		expect(stored.temperature).toBe(1.5);
		expect(stored.contextLimit).toBe(4096);
		expect(stored.safetyAllowance).toBe(500);
		expect(session.events).toEqual([
			"adopt:6",
			"panel-applied",
			"adopt:7",
			"model-committed:qwen3-max",
			"adopt:8",
			"panel-applied",
		]);
	});

	test("the panel's write overrides the freshly read base with every draft-owned field", async () => {
		const backend = createConversationBackend();
		const inner = backend.handler;
		backend.handler = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if ((init?.method ?? "GET") === "GET" && url.endsWith("/api/conversations/1/generation-settings")) {
				// An authoritative base that disagrees with every local draft.
				return Response.json({
					...baseSettings(),
					modelId: "authoritative-model",
					temperature: 2,
					contextLimit: 8192,
					continuationInstruction: "Authoritative instruction.",
				});
			}
			return inner(input, init);
		};
		installFetch(backend.handler);
		const session = createSession();

		await session.savePanelDraft({
			sampling: { temperature: 0.3 },
			budget: { contextLimit: 2048 },
		});

		// SAFETY: only one command was sent, and it is the panel's full write
		// carrying the asserted settings shape.
		const [panelWrite] = backend.commands as [{ type: string; settings: ConversationGenerationSettings }];
		expect(panelWrite.type).toBe("update-generation-settings");
		// Draft-owned fields win; only the model selection comes from the base.
		expect(panelWrite.settings.temperature).toBe(0.3);
		expect(panelWrite.settings.contextLimit).toBe(2048);
		expect(panelWrite.settings.continuationInstruction).toBe("Continue the narrative.");
		expect(panelWrite.settings.modelId).toBe("authoritative-model");
	});
});
