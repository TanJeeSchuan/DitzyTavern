import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import {
	ConversationNotFoundError,
	createConversationModule,
} from "../conversation";
import { requireSnapshot } from "../conversation/test-fixtures";
import { openInitializedDatabase } from "../database/database";
import { gracefullyShutdownGenerations } from "../workflows/generation-recovery";
import {
	generationRuntimeFor,
	type GenerationRuntime,
	type StartGenerationRuntimeInput,
} from "../workflows";
import {
	createGenerationCoordinator,
	type GenerationStopAllOutcome,
	type GenerationStopOutcome,
} from "./generation-coordinator";

const key = new Uint8Array(32).fill(31);
const prompt = {
	systemInstruction: "Write briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};
const profile = {
	displayName: "Coordinator Test",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43127/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "deepseek" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: [],
};

const streamResponse = () => new Response(
	["data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Coordinator output.\"},\"finish_reason\":null}]}\n\n", "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", "data: [DONE]\n\n"].join(""),
	{ headers: { "content-type": "text/event-stream" } },
);

describe("GenerationCoordinator", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	// Generation results carry the Conversation header; Message assertions
	// re-read the full snapshot immediately after the attempt they follow.
	const currentSnapshot = (conversationId: number) =>
		requireSnapshot(createConversationModule(database), conversationId);

	test("shares runtime and transport setup across tail, continuation, and sibling starts", async () => {
		const conversation = createConversationModule(database).create({
			name: "Coordinator Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "coordinator-test-secret",
		});
		const coordinator = createGenerationCoordinator(database, {
			masterKey: key,
			fetch: async () => streamResponse(),
		});

		const first = await coordinator.startGeneration({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			content: "Start the scene.",
		});
		const firstResult = await first.result;
		expect(first.runtime.state.status).toBe("complete");
		expect(currentSnapshot(conversation.id).messages).toHaveLength(2);

		const continuation = await coordinator.startGeneration({
			conversationId: conversation.id,
			expectedRevision: firstResult.conversation.revision,
		});
		await continuation.result;
		expect(continuation.runtime.state.status).toBe("complete");
		expect(currentSnapshot(conversation.id).messages).toHaveLength(3);

		const targetMessageId = firstResult.messageId;
		const sibling = await coordinator.startGeneration({
			conversationId: conversation.id,
			messageId: targetMessageId,
		});
		const siblingResult = await sibling.result;
		expect(sibling.runtime.state.status).toBe("complete");
		expect(siblingResult).toEqual(expect.objectContaining({
			generationId: sibling.runtime.state.generationId,
			messageId: targetMessageId,
			provisionalVariantId: expect.any(Number),
		}));
	});

	test("rejects a missing conversation before resolving transport", async () => {
		const coordinator = createGenerationCoordinator(database);

		await expect(coordinator.startGeneration({
			conversationId: 404,
			expectedRevision: 0,
			content: "Start the scene.",
		})).rejects.toBeInstanceOf(ConversationNotFoundError);
	});

	test("shutdown joins a provider that settles after cancellation before closing the database", async () => {
		const conversation = createConversationModule(database).create({
			name: "Shutdown Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0, profile, credential: "shutdown-test-secret",
		});
		const requested = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const coordinator = createGenerationCoordinator(database, {
			masterKey: key,
			fetch: () => { requested.resolve(); return response.promise; },
		});
		const started = await coordinator.startGeneration({
			conversationId: conversation.id, expectedRevision: conversation.revision, content: "Stop on shutdown.",
		});
		await requested.promise;
		let drained = false;
		const shutdown = gracefullyShutdownGenerations(database).then(() => { drained = true; });
		await Promise.resolve();
		expect(drained).toBe(false);
		response.resolve(streamResponse());
		await shutdown;
		database.close();
		const prepare = spyOn(database, "prepare");
		const transaction = spyOn(database, "transaction");
		try {
			await expect(started.result).rejects.toThrow();
			expect(prepare).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
			transaction.mockRestore();
		}
	}, 10_000);

	test("stops a running attempt through one application entrance", async () => {
		const conversation = createConversationModule(database).create({
			name: "Coordinator Stop Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "coordinator-stop-secret",
		});
		let providerSignal: AbortSignal | undefined;
		const coordinator = createGenerationCoordinator(database, {
			masterKey: key,
			fetch: async (_input, init) => {
				providerSignal = init?.signal ?? undefined;
				// Keep the provider request pending until the explicit Stop aborts it.
				await new Promise<void>((resolve) => {
					if (init?.signal?.aborted === true) {
						resolve();
						return;
					}
					init?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return new Response(null, { headers: { "content-type": "text/event-stream" } });
			},
		});

		const started = await coordinator.startGeneration({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			content: "Stop me.",
		});
		for (let attempt = 0; attempt < 20 && providerSignal === undefined; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(providerSignal).toBeDefined();

		const outcome = await coordinator.stopGeneration(conversation.id, started.accepted.generationId);

		expect(outcome.outcome).toBe("stopped");
		if (outcome.outcome === "stopped") {
			expect(outcome.generationId).toBe(started.accepted.generationId);
			expect(outcome.conversation.activeGenerations).toEqual([]);
			const stoppedMessages = currentSnapshot(conversation.id).messages;
			expect(stoppedMessages).toHaveLength(1);
			expect(stoppedMessages[0]?.variants[0]?.content).toBe("Stop me.");
		}
		expect(started.runtime.state.status).toBe("stopped");
		expect(providerSignal?.aborted).toBe(true);
		await expect(started.result).rejects.toThrow();
		const snapshot = createConversationModule(database).getSnapshot(conversation.id);
		expect(snapshot?.activeGenerations).toEqual([]);
		expect(snapshot?.messages).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Stop lifecycle outcomes against the real registry and Conversation module
// ---------------------------------------------------------------------------

const expectOutcome = <Kind extends GenerationStopOutcome["outcome"]>(
	outcome: GenerationStopOutcome,
	kind: Kind,
): Extract<GenerationStopOutcome, { outcome: Kind }> => {
	if (outcome.outcome !== kind) {
		throw new Error(`Expected outcome ${kind}, received ${outcome.outcome}.`);
	}
	// SAFETY: the discriminant check above proves the outcome variant at
	// runtime; the assertion only narrows the union, never rewrites the value.
	return outcome as Extract<GenerationStopOutcome, { outcome: Kind }>;
};

const expectStopAllOutcome = <Kind extends GenerationStopAllOutcome["outcome"]>(
	outcome: GenerationStopAllOutcome,
	kind: Kind,
): Extract<GenerationStopAllOutcome, { outcome: Kind }> => {
	if (outcome.outcome !== kind) {
		throw new Error(`Expected outcome ${kind}, received ${outcome.outcome}.`);
	}
	// SAFETY: the discriminant check above proves the outcome variant at
	// runtime; the assertion only narrows the union, never rewrites the value.
	return outcome as Extract<GenerationStopAllOutcome, { outcome: Kind }>;
};

describe("Generation Coordinator Stop lifecycle", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	const setup = () => {
		const module = createConversationModule(database);
		const conversation = module.create({
			name: "Stop lifecycle",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Original."] } },
			],
			control: { human: 0, model: 1 },
		});
		const human = conversation.cast[0];
		const model = conversation.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		return { module, conversation, human, model };
	};

	const acceptTail = (input: ReturnType<typeof setup>, content: string) =>
		input.module.acceptTailGeneration({
			conversationId: input.conversation.id,
			expectedRevision: input.conversation.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			humanContent: content,
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
			capturedModelName: input.model.name,
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});

	const acceptSibling = (input: ReturnType<typeof setup>, messageId: number, timestamp: string) =>
		input.module.acceptSiblingGeneration({
			conversationId: input.conversation.id,
			messageId,
			timestamp,
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
			capturedModelName: input.model.name,
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});

	const startRuntime = (
		conversationId: number,
		accepted: { generationId: number; messageId: number; provisionalVariantId: number },
		input: Partial<StartGenerationRuntimeInput> = {},
	) =>
		generationRuntimeFor(database).start({
			generationId: accepted.generationId,
			conversationId,
			messageId: accepted.messageId,
			variantId: accepted.provisionalVariantId,
			startedAt: "2026-08-27T00:00:00.000Z",
			...input,
		});

	test("Stop forces the runtime stop before the durable transition and settles the runtime after", async () => {
		const input = setup();
		const accepted = acceptTail(input, "Stop me.");
		const activeAtAbort: number[] = [];
		const runtime = startRuntime(input.conversation.id, accepted, {
			onStop: () => {
				// Observed by the real runtime during its own stop() call.
				const active = input.module.getSnapshot(input.conversation.id)?.activeGenerations ?? [];
				activeAtAbort.push(...active.map((entry) => entry.generationId));
			},
		});
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopGeneration(input.conversation.id, accepted.generationId);

		const stopped = expectOutcome(outcome, "stopped");
		expect(stopped.generationId).toBe(accepted.generationId);
		expect(stopped.unsettledReason).toBeNull();
		expect(stopped.conversation.id).toBe(input.conversation.id);
		// Ordering through real effects: the provider abort observed the
		// still-Active Generation, and the durable interrupted transition
		// followed it before the runtime settled terminal.
		expect(activeAtAbort).toEqual([accepted.generationId]);
		expect(runtime.state.status).toBe("stopped");
		expect(input.module.getSnapshot(input.conversation.id)?.activeGenerations).toEqual([]);
	});

	test("Stop stops nothing when no runtime exists and the durable target is gone", async () => {
		const input = setup();
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopGeneration(input.conversation.id, 404_404);

		expect(expectOutcome(outcome, "not-stoppable").generationId).toBe(404_404);
		expect(input.module.getSnapshot(input.conversation.id)?.activeGenerations).toEqual([]);
	});

	test("Stop stops nothing and never touches durable state when the runtime belongs to another Conversation", async () => {
		const addressed = setup();
		const owner = setup();
		const accepted = acceptTail(owner, "Owned elsewhere.");
		const runtime = startRuntime(owner.conversation.id, accepted);
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopGeneration(addressed.conversation.id, accepted.generationId);

		expect(expectOutcome(outcome, "not-stoppable").generationId).toBe(accepted.generationId);
		// The addressed Conversation has no such Generation; durable state is
		// never consulted under another Conversation's name.
		expect(owner.module.getSnapshot(owner.conversation.id)?.activeGenerations).toHaveLength(1);
		expect(runtime.state.status).toBe("active");
		expect(runtime.isStopRequested).toBe(false);
	});

	test("Stop does not commit stale output when the runtime checkpoint fails", async () => {
		const input = setup();
		const accepted = acceptTail(input, "Checkpoint me.");
		const runtime = startRuntime(input.conversation.id, accepted, {
			onCheckpoint: () => {
				throw new Error("Checkpoint write failed.");
			},
		});
		// One observed delta makes the runtime's next flush a real checkpoint
		// attempt, so the abort fails before any durable transition runs.
		runtime.publish({ type: "content", text: "partial output" });
		const coordinator = createGenerationCoordinator(database);

		await expect(coordinator.stopGeneration(input.conversation.id, accepted.generationId))
			.rejects.toThrow("Checkpoint write failed.");

		// The durable transition never ran: the Active Generation survives so
		// a later Stop cannot settle from stale output.
		expect(input.module.getSnapshot(input.conversation.id)?.activeGenerations).toHaveLength(1);
		expect(runtime.state.status).toBe("active");
	});

	test("Stop All flushes checkpoints, commits the durable transition, then settles each runtime", async () => {
		const input = setup();
		// The sibling target is the configured opening Message, whose captured
		// historical Control pair makes sibling acceptance eligible.
		const target = input.conversation.messages[0];
		if (target === undefined) throw new Error("Opening target missing.");
		const first = acceptSibling(input, target.id, "2026-08-27T00:00:01.000Z");
		const second = acceptSibling(input, target.id, "2026-08-27T00:00:02.000Z");
		const activeAtAbort: number[] = [];
		const firstRuntime = startRuntime(input.conversation.id, first, {
			onStop: () => {
				activeAtAbort.push(input.module.getSnapshot(input.conversation.id)?.activeGenerations.length ?? -1);
			},
		});
		const secondRuntime = startRuntime(input.conversation.id, second, {
			onStop: () => {
				activeAtAbort.push(input.module.getSnapshot(input.conversation.id)?.activeGenerations.length ?? -1);
			},
		});
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopAllGenerations(input.conversation.id);

		const stopped = expectStopAllOutcome(outcome, "stopped");
		expect([...stopped.generationIds]).toEqual([first.generationId, second.generationId]);
		expect(stopped.unsettled).toEqual([]);
		expect(stopped.unsettledReason).toBeNull();
		expect(stopped.conversation.id).toBe(input.conversation.id);
		// Ordering through real effects: Stop All secures the durable
		// transition first, so both aborts observe an already-empty Active set,
		// and each runtime settles only afterwards.
		expect(activeAtAbort).toEqual([0, 0]);
		expect(firstRuntime.state.status).toBe("stopped");
		expect(secondRuntime.state.status).toBe("stopped");
	});

	test("Stop All settles only runtimes owned by the addressed Conversation", async () => {
		const owner = setup();
		const foreign = setup();
		const ownerTarget = owner.conversation.messages[0];
		if (ownerTarget === undefined) throw new Error("Opening target missing.");
		const ownerAccepted = acceptSibling(owner, ownerTarget.id, "2026-08-27T00:00:01.000Z");
		const foreignAccepted = acceptTail(foreign, "Owned elsewhere.");
		const ownerRuntime = startRuntime(owner.conversation.id, ownerAccepted);
		const foreignRuntime = startRuntime(foreign.conversation.id, foreignAccepted);
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopAllGenerations(owner.conversation.id);

		const stopped = expectStopAllOutcome(outcome, "stopped");
		expect([...stopped.generationIds]).toEqual([ownerAccepted.generationId]);
		expect(ownerRuntime.state.status).toBe("stopped");
		// The foreign runtime belongs to another Conversation: never flushed,
		// never aborted, never settled.
		expect(foreignRuntime.state.status).toBe("active");
	});

	test("Stop All stops nothing and settles no runtime when the durable transition cannot commit", async () => {
		const input = setup();
		const accepted = acceptTail(input, "Finish first.");
		const runtime = startRuntime(input.conversation.id, accepted);
		// The provider wins the race: the Generation resolves durably and the
		// terminal runtime lingers only for its replay window.
		input.module.resolveGeneration({
			conversationId: input.conversation.id,
			generationId: accepted.generationId,
			timestamp: "2026-08-27T00:00:05.000Z",
			content: "Provider won.",
		});
		runtime.complete();
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopAllGenerations(input.conversation.id);

		expect(outcome.outcome).toBe("not-stoppable");
		// The durable commit never named a target set, so the retained runtime
		// keeps its own terminal state instead of being marked stopped.
		expect(runtime.state.status).toBe("complete");
	});

	test("Stop All stops nothing for an unknown Conversation", async () => {
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopAllGenerations(404_404);

		expect(outcome.outcome).toBe("not-stoppable");
	});
});

// ---------------------------------------------------------------------------
// Terminal races with real Conversation and runtime collaborators
// ---------------------------------------------------------------------------

describe("Generation Coordinator terminal races", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	const setup = () => {
		const module = createConversationModule(database);
		const conversation = module.create({
			name: "Terminal race",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Original."] } },
			],
			control: { human: 0, model: 1 },
		});
		const human = conversation.cast[0];
		const model = conversation.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		return { module, conversation, human, model };
	};

	const acceptTail = (input: ReturnType<typeof setup>, content: string) =>
		input.module.acceptTailGeneration({
			conversationId: input.conversation.id,
			expectedRevision: input.conversation.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			humanContent: content,
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
			capturedModelName: input.model.name,
		promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});

	test("Stop releases terminal ownership when the provider wins during cancellation", async () => {
		const input = setup();
		const accepted = acceptTail(input, "Finish this.");
		let runtime!: GenerationRuntime;
		const terminalStates: string[] = [];
		runtime = generationRuntimeFor(database).start({
			generationId: accepted.generationId,
			conversationId: input.conversation.id,
			messageId: accepted.messageId,
			variantId: accepted.provisionalVariantId,
			startedAt: "2026-08-27T00:00:00.000Z",
			onStop: () => {
				input.module.resolveGeneration({
					conversationId: input.conversation.id,
					generationId: accepted.generationId,
					timestamp: "2026-08-27T00:00:01.000Z",
					content: "Provider won.",
				});
				runtime.complete();
			},
		});
		runtime.onStateChange((state) => {
			if (state.status !== "active") terminalStates.push(state.status);
		});
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopGeneration(input.conversation.id, accepted.generationId);

		expect(outcome.outcome).toBe("not-stoppable");
		expect(runtime.state.status).toBe("complete");
		expect(terminalStates).toEqual(["complete"]);
		const snapshot = input.module.getSnapshot(input.conversation.id);
		expect(snapshot?.activeGenerations).toEqual([]);
		expect(snapshot?.messages.at(-1)?.variants).toHaveLength(1);
		expect(snapshot?.messages.at(-1)?.variants[0]?.content).toBe("Provider won.");
		expect(snapshot?.messages.at(-1)?.variants[0]?.data).not.toContainEqual(
			{ namespace: "generation", key: "outcome", value: "interrupted" },
		);
	});

	test("Stop All commits every target before settling provider runtimes", async () => {
		const input = setup();
		// The sibling target is the configured opening Message, whose captured
		// historical Control pair makes sibling acceptance eligible.
		const target = input.conversation.messages[0];
		if (target === undefined) throw new Error("Opening target missing.");
		const acceptSibling = (timestamp: string) => input.module.acceptSiblingGeneration({
			conversationId: input.conversation.id,
			messageId: target.id,
			timestamp,
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
			capturedModelName: input.model.name,
		promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});
		const providerWinner = acceptSibling("2026-08-27T00:00:01.000Z");
		const stopWinner = acceptSibling("2026-08-27T00:00:02.000Z");
		let providerRuntime!: GenerationRuntime;
		providerRuntime = generationRuntimeFor(database).start({
			generationId: providerWinner.generationId,
			conversationId: input.conversation.id,
			messageId: providerWinner.messageId,
			variantId: providerWinner.provisionalVariantId,
			startedAt: "2026-08-27T00:00:01.000Z",
			onStop: () => {
				// Stop All must secure the durable Conversation transition before
				// asking this provider attempt to abort.
				expect(input.module.getSnapshot(input.conversation.id)?.activeGenerations).toEqual([]);
			},
		});
		const stopRuntime = generationRuntimeFor(database).start({
			generationId: stopWinner.generationId,
			conversationId: input.conversation.id,
			messageId: stopWinner.messageId,
			variantId: stopWinner.provisionalVariantId,
			startedAt: "2026-08-27T00:00:02.000Z",
		});
		const providerTerminalStates: string[] = [];
		const stopTerminalStates: string[] = [];
		providerRuntime.onStateChange((state) => {
			if (state.status !== "active") providerTerminalStates.push(state.status);
		});
		stopRuntime.onStateChange((state) => {
			if (state.status !== "active") stopTerminalStates.push(state.status);
		});
		const coordinator = createGenerationCoordinator(database);

		const outcome = await coordinator.stopAllGenerations(input.conversation.id);

		const stopped = expectStopAllOutcome(outcome, "stopped");
		expect([...stopped.generationIds]).toEqual([providerWinner.generationId, stopWinner.generationId]);
		expect(providerRuntime.state.status).toBe("stopped");
		expect(stopRuntime.state.status).toBe("stopped");
		expect(providerTerminalStates).toEqual(["stopped"]);
		expect(stopTerminalStates).toEqual(["stopped"]);
		const snapshot = input.module.getSnapshot(input.conversation.id);
		expect(snapshot?.activeGenerations).toEqual([]);
		expect(snapshot?.messages[0]?.variants.map((variant) => variant.content)).toEqual(["Original."]);
		expect(snapshot?.messages[0]?.variants.filter((variant) => variant.selected)).toHaveLength(1);
	});
});
