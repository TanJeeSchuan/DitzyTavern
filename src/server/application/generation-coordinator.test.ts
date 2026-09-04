import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import {
	ConversationNotFoundError,
	InvalidConversationCommandError,
	createConversationModule,
	type ConversationSnapshot,
} from "../conversation";
import { openDatabase } from "../database/database";
import {
	generationRuntimeFor,
	type GenerationRuntime,
	type GenerationRuntimeState,
} from "../workflows";
import {
	createGenerationCoordinator,
	type GenerationConversationLifecycle,
	type GenerationRuntimeHandle,
	type GenerationRuntimeLifecycle,
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
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

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

		const first = await coordinator.startSendGeneration({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			content: "Start the scene.",
		});
		const firstResult = await first.result;
		expect(first.runtime.state.status).toBe("complete");
		expect(firstResult.conversation.messages).toHaveLength(2);

		const continuation = await coordinator.startContinuationGeneration({
			conversationId: conversation.id,
			expectedRevision: firstResult.conversation.revision,
		});
		const continuationResult = await continuation.result;
		expect(continuation.runtime.state.status).toBe("complete");
		expect(continuationResult.conversation.messages).toHaveLength(3);

		const targetMessageId = firstResult.messageId;
		const sibling = await coordinator.startSiblingGeneration({
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

		await expect(coordinator.startSendGeneration({
			conversationId: 404,
			expectedRevision: 0,
			content: "Start the scene.",
		})).rejects.toBeInstanceOf(ConversationNotFoundError);
	});

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

		const started = await coordinator.startSendGeneration({
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
			expect(outcome.conversation.messages).toHaveLength(1);
			expect(outcome.conversation.messages[0]?.variants[0]?.content).toBe("Stop me.");
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
// Lifecycle outcomes with fake runtime and Conversation adapters
// ---------------------------------------------------------------------------

interface RuntimeFake {
	/** Invoked inside stop() before any stopError is raised. */
	onStop?: () => void;
	stopError?: Error;
	markStoppedError?: Error;
	status?: GenerationRuntimeState["status"];
}

// Records every lifecycle call into one shared order log so tests assert
// exact sequencing across the runtime and Conversation adapters.
const recordRuntime = (
	order: string[],
	generationId: number,
	conversationId: number,
	fake: RuntimeFake = {},
): GenerationRuntimeHandle => ({
	state: {
		generationId,
		conversationId,
		messageId: 0,
		variantId: 0,
		startedAt: "2026-08-27T00:00:00.000Z",
		content: "",
		reasoning: "",
		latestEventId: 0,
		status: fake.status ?? "active",
		terminalReason: null,
	},
	stop: () => {
		order.push(`stop:${generationId}`);
		if (fake.stopError !== undefined) throw fake.stopError;
		fake.onStop?.();
	},
	markStopped: () => {
		order.push(`markStopped:${generationId}`);
		if (fake.markStoppedError !== undefined) throw fake.markStoppedError;
	},
	releaseStopRequest: () => {
		order.push(`releaseStopRequest:${generationId}`);
	},
});

const fakeRuntimeLifecycle = (
	runtimes: ReadonlyMap<number, GenerationRuntimeHandle>,
	order: string[],
): GenerationRuntimeLifecycle => ({
	get: (generationId) => runtimes.get(generationId),
	flushAll: (conversationId) => {
		order.push(`flushAll:${conversationId}`);
	},
});

interface ConversationFake {
	stopError?: Error;
	stopGenerationsError?: Error;
	/** Durable target set returned by the scripted Stop All transition. */
	stopGenerationsIds?: number[];
}

const fakeConversationLifecycle = (
	snapshot: ConversationSnapshot,
	order: string[],
	fake: ConversationFake = {},
): GenerationConversationLifecycle => ({
	stopGeneration: (input) => {
		order.push(`durableStop:${input.generationId}`);
		if (fake.stopError !== undefined) throw fake.stopError;
		return snapshot;
	},
	stopGenerations: (input) => {
		order.push(`durableStopAll:${input.conversationId}`);
		if (fake.stopGenerationsError !== undefined) throw fake.stopGenerationsError;
		return { generationIds: fake.stopGenerationsIds ?? [], conversation: snapshot };
	},
});

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

describe("Generation Coordinator Stop lifecycle outcomes", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	const conversationSnapshot = (name: string): ConversationSnapshot =>
		createConversationModule(database).create({
			name,
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Original."] } },
			],
			control: { human: 0, model: 1 },
		});

	test("Stop forces the runtime stop before the durable transition and settles the runtime after", async () => {
		const conversation = conversationSnapshot("Stop ordering");
		const order: string[] = [];
		const runtime = recordRuntime(order, 11, conversation.id);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order),
			runtimeLifecycle: fakeRuntimeLifecycle(new Map([[11, runtime]]), order),
		});

		const outcome = await coordinator.stopGeneration(conversation.id, 11);

		expect(expectOutcome(outcome, "stopped").conversation.id).toBe(conversation.id);
		expect(order).toEqual([
			`stop:11`,
			`durableStop:11`,
			`markStopped:11`,
		]);
	});

	test("Stop stops nothing and releases the runtime when natural completion wins the race", async () => {
		const conversation = conversationSnapshot("Stop race");
		const order: string[] = [];
		const runtime = recordRuntime(order, 12, conversation.id);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopError: new InvalidConversationCommandError("The Active Generation is no longer available."),
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(new Map([[12, runtime]]), order),
		});

		const outcome = await coordinator.stopGeneration(conversation.id, 12);

		expect(expectOutcome(outcome, "not-stoppable").generationId).toBe(12);
		// The losing Stop request returns terminal ownership to the provider;
		// the runtime settles through its own terminal event instead.
		expect(order).toEqual([
			`stop:12`,
			`durableStop:12`,
			`releaseStopRequest:12`,
		]);
	});

	test("Stop stops nothing when no runtime exists and the durable target is gone", async () => {
		const conversation = conversationSnapshot("Stop missing");
		const order: string[] = [];
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopError: new InvalidConversationCommandError("The Active Generation is no longer available."),
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(new Map(), order),
		});

		const outcome = await coordinator.stopGeneration(conversation.id, 13);

		expect(expectOutcome(outcome, "not-stoppable").generationId).toBe(13);
		expect(order).toEqual([`durableStop:13`]);
	});

	test("Stop stops nothing and releases the runtime when the Conversation is unknown", async () => {
		const conversation = conversationSnapshot("Stop unknown conversation");
		const order: string[] = [];
		const runtime = recordRuntime(order, 14, conversation.id);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopError: new ConversationNotFoundError(conversation.id),
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(new Map([[14, runtime]]), order),
		});

		const outcome = await coordinator.stopGeneration(conversation.id, 14);

		expect(expectOutcome(outcome, "not-stoppable").generationId).toBe(14);
		expect(order).toEqual([
			`stop:14`,
			`durableStop:14`,
			`releaseStopRequest:14`,
		]);
	});

	test("Stop stops nothing and never touches durable state when the runtime belongs to another Conversation", async () => {
		const conversation = conversationSnapshot("Stop foreign runtime");
		const order: string[] = [];
		const runtime = recordRuntime(order, 15, conversation.id + 999);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order),
			runtimeLifecycle: fakeRuntimeLifecycle(new Map([[15, runtime]]), order),
		});

		const outcome = await coordinator.stopGeneration(conversation.id, 15);

		expect(expectOutcome(outcome, "not-stoppable").generationId).toBe(15);
		expect(order).toEqual([]);
	});

	test("Stop reports the unsettled runtime reason when the durable commit succeeds but the runtime cannot settle", async () => {
		const conversation = conversationSnapshot("Stop settlement failure");
		const order: string[] = [];
		const runtime = recordRuntime(order, 16, conversation.id, {
			markStoppedError: new Error("Runtime settlement exploded."),
		});
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order),
			runtimeLifecycle: fakeRuntimeLifecycle(new Map([[16, runtime]]), order),
		});

		const outcome = await coordinator.stopGeneration(conversation.id, 16);

		const settled = expectOutcome(outcome, "stopped");
		expect(settled.generationId).toBe(16);
		expect(settled.unsettledReason).toBe("Runtime settlement exploded.");
		expect(settled.conversation.id).toBe(conversation.id);
		// The durable transition still committed: the Conversation snapshot
		// remains authoritative even though the runtime entry lingers.
		expect(order).toEqual([
			`stop:16`,
			`durableStop:16`,
			`markStopped:16`,
		]);
	});

	test("Stop reports the unsettled runtime reason when the runtime cannot stop but still commits the durable transition", async () => {
		const conversation = conversationSnapshot("Stop request failure");
		const order: string[] = [];
		const runtime = recordRuntime(order, 18, conversation.id, {
			stopError: new Error("Runtime abort failed."),
		});
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order),
			runtimeLifecycle: fakeRuntimeLifecycle(new Map([[18, runtime]]), order),
		});

		const outcome = await coordinator.stopGeneration(conversation.id, 18);

		const settled = expectOutcome(outcome, "stopped");
		expect(settled.unsettledReason).toBe("Runtime abort failed.");
		expect(settled.conversation.id).toBe(conversation.id);
		// A runtime glitch must never lose the Stop intent: the durable
		// transition still commits, and settlement is not attempted again
		// after the failed stop request.
		expect(order).toEqual([
			`stop:18`,
			`durableStop:18`,
		]);
	});

	test("Stop All flushes checkpoints, commits the durable transition, then settles each runtime", async () => {
		const conversation = conversationSnapshot("Stop All ordering");
		const order: string[] = [];
		const runtimes = new Map<number, GenerationRuntimeHandle>([
			[21, recordRuntime(order, 21, conversation.id)],
			[22, recordRuntime(order, 22, conversation.id)],
		]);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopGenerationsIds: [21, 22],
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(runtimes, order),
		});

		const outcome = await coordinator.stopAllGenerations(conversation.id);

		const stopped = expectStopAllOutcome(outcome, "stopped");
		expect([...stopped.generationIds]).toEqual([21, 22]);
		expect(stopped.conversation.id).toBe(conversation.id);
		// Forced checkpoints and the durable commit strictly precede runtime
		// settlement, so the interrupted transition observes every delta and
		// aborts only targets the durable transition actually committed.
		expect(order).toEqual([
			`flushAll:${conversation.id}`,
			`durableStopAll:${conversation.id}`,
			`stop:21`,
			`markStopped:21`,
			`stop:22`,
			`markStopped:22`,
		]);
	});

	test("Stop All settles only runtimes owned by the addressed Conversation", async () => {
		const conversation = conversationSnapshot("Stop All ownership");
		const order: string[] = [];
		const runtimes = new Map<number, GenerationRuntimeHandle>([
			// A stale registry entry reusing a generation id of another chat.
			[31, recordRuntime(order, 31, conversation.id + 777)],
		]);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopGenerationsIds: [31],
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(runtimes, order),
		});

		const outcome = await coordinator.stopAllGenerations(conversation.id);

		expect(expectStopAllOutcome(outcome, "stopped").generationIds).toEqual([31]);
		expect(order).toEqual([
			`flushAll:${conversation.id}`,
			`durableStopAll:${conversation.id}`,
		]);
	});

	test("Stop All stops nothing and settles no runtime when the durable transition cannot commit", async () => {
		const conversation = conversationSnapshot("Stop All missing");
		const order: string[] = [];
		const runtimes = new Map<number, GenerationRuntimeHandle>([
			[41, recordRuntime(order, 41, conversation.id)],
		]);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopGenerationsError: new InvalidConversationCommandError(
					"The Conversation has no active Generations to stop.",
				),
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(runtimes, order),
		});

		const outcome = await coordinator.stopAllGenerations(conversation.id);

		expect(outcome.outcome).toBe("not-stoppable");
		// Forced checkpoints happen before the durable attempt; settlement must
		// not start because the durable commit never named a target set.
		expect(order).toEqual([
			`flushAll:${conversation.id}`,
			`durableStopAll:${conversation.id}`,
		]);
	});

	test("Stop All reports the unsettled targets and still settles the remaining runtimes", async () => {
		const conversation = conversationSnapshot("Stop All partial settlement");
		const order: string[] = [];
		const runtimes = new Map<number, GenerationRuntimeHandle>([
			[51, recordRuntime(order, 51, conversation.id)],
			[52, recordRuntime(order, 52, conversation.id, {
				markStoppedError: new Error("Runtime 52 refused settlement."),
			})],
			[53, recordRuntime(order, 53, conversation.id)],
		]);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopGenerationsIds: [51, 52, 53],
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(runtimes, order),
		});

		const outcome = await coordinator.stopAllGenerations(conversation.id);

		const settled = expectStopAllOutcome(outcome, "stopped");
		expect([...settled.unsettled]).toEqual([52]);
		expect(settled.unsettledReason).toBe("Runtime 52 refused settlement.");
		expect([...settled.generationIds]).toEqual([51, 52, 53]);
		expect(settled.conversation.id).toBe(conversation.id);
		expect(order).toEqual([
			`flushAll:${conversation.id}`,
			`durableStopAll:${conversation.id}`,
			`stop:51`,
			`markStopped:51`,
			`stop:52`,
			`markStopped:52`,
			`stop:53`,
			`markStopped:53`,
		]);
	});

	test("Stop All counts a runtime that cannot stop as unsettled and keeps settling the rest", async () => {
		const conversation = conversationSnapshot("Stop All abort failure");
		const order: string[] = [];
		const runtimes = new Map<number, GenerationRuntimeHandle>([
			[54, recordRuntime(order, 54, conversation.id)],
			[55, recordRuntime(order, 55, conversation.id, {
				stopError: new Error("Runtime 55 abort failed."),
			})],
		]);
		const coordinator = createGenerationCoordinator(undefined, {
			conversationLifecycle: fakeConversationLifecycle(conversation, order, {
				stopGenerationsIds: [54, 55],
			}),
			runtimeLifecycle: fakeRuntimeLifecycle(runtimes, order),
		});

		const outcome = await coordinator.stopAllGenerations(conversation.id);

		const settled = expectStopAllOutcome(outcome, "stopped");
		expect([...settled.unsettled]).toEqual([55]);
		expect(settled.unsettledReason).toBe("Runtime 55 abort failed.");
		expect(order).toEqual([
			`flushAll:${conversation.id}`,
			`durableStopAll:${conversation.id}`,
			`stop:54`,
			`markStopped:54`,
			`stop:55`,
		]);
	});
});

// ---------------------------------------------------------------------------
// Terminal races with real Conversation and runtime collaborators
// ---------------------------------------------------------------------------

describe("Generation Coordinator terminal races", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
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
			promptPlan: {},
			historyRoles: [],
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
			promptPlan: {},
			historyRoles: [],
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
