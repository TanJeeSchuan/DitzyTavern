import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type {
	GenerationConversationLifecycle,
	GenerationRuntimeHandle,
	GenerationRuntimeLifecycle,
} from "../application/generation-coordinator";
import {
	InvalidConversationCommandError,
	createConversationModule,
	type ConversationSnapshot,
} from "../conversation";
import { openInitializedDatabase } from "../database/database";
import { createConversationRoutes } from "./conversation";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

// Route tests own one responsibility only: mapping typed Generation lifecycle
// outcomes onto transport responses. Ordering, races, and settlement belong to
// the Coordinator tests; the scripted adapters here return outcomes without
// reproducing any lifecycle behavior.

const scriptedRuntime = (
	generationId: number,
	conversationId: number,
	options: { markStoppedError?: Error } = {},
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
		status: "active",
		terminalReason: null,
	},
	stop: () => {},
	markStopped: () => {
		if (options.markStoppedError !== undefined) throw options.markStoppedError;
	},
	releaseStopRequest: () => {},
});

const scriptedRuntimes = (
	entries: readonly GenerationRuntimeHandle[],
): GenerationRuntimeLifecycle => {
	const byId = new Map(entries.map((runtime) => [runtime.state.generationId, runtime]));
	return {
		get: (generationId) => byId.get(generationId),
		flushAll: () => {},
	};
};

const scriptedConversation = (
	snapshot: ConversationSnapshot,
	fake: { invalidStop?: boolean; invalidStopAll?: boolean; generationIds?: number[] } = {},
): GenerationConversationLifecycle => ({
	stopGeneration: () => {
		if (fake.invalidStop === true) {
			throw new InvalidConversationCommandError("The Active Generation is no longer available.");
		}
		return snapshot;
	},
	stopGenerations: () => {
		if (fake.invalidStopAll === true) {
			throw new InvalidConversationCommandError("The Conversation has no active Generations to stop.");
		}
		return { generationIds: fake.generationIds ?? [], conversation: snapshot };
	},
});

describe("Generation Stop route mapping", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	const snapshot = (): ConversationSnapshot =>
		createConversationModule(database).create({
			name: "Stop mapping",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Original."] } },
			],
			control: { human: 0, model: 1 },
		});

	const stopRoute = async (
		conversationLifecycle: GenerationConversationLifecycle,
		runtimeLifecycle: GenerationRuntimeLifecycle,
		conversationId: number,
		generationId: number,
	) => createConversationRoutes(database, { conversationLifecycle, runtimeLifecycle }).handle(
		new Request(`http://localhost/api/conversations/${conversationId}/generations/${generationId}/stop`, {
			method: "POST",
			body: "{}",
		}),
	);

	const stopAllRoute = async (
		conversationLifecycle: GenerationConversationLifecycle,
		runtimeLifecycle: GenerationRuntimeLifecycle,
		conversationId: number,
	) => createConversationRoutes(database, { conversationLifecycle, runtimeLifecycle }).handle(
		new Request(`http://localhost/api/conversations/${conversationId}/generations/stop-all`, {
			method: "POST",
			body: "{}",
		}),
	);

	test("maps a stopped Generation onto the stopped transport response", async () => {
		const conversation = snapshot();
		const response = await stopRoute(
			scriptedConversation(conversation),
			scriptedRuntimes([scriptedRuntime(7, conversation.id)]),
			conversation.id,
			7,
		);
		// SAFETY: this test controls the mapped response shape.
		const body = await response.json() as {
			outcome: string;
			generationId: number;
			conversation: { id: number };
		};

		expect(response.status).toBe(200);
		expect(body.outcome).toBe("stopped");
		expect(body.generationId).toBe(7);
		expect(body.conversation.id).toBe(conversation.id);
	});

	test("maps a missing Generation onto the not-found transport response", async () => {
		const conversation = snapshot();
		const response = await stopRoute(
			scriptedConversation(conversation, { invalidStop: true }),
			scriptedRuntimes([]),
			conversation.id,
			13,
		);
		// SAFETY: this test controls the mapped not-found response shape.
		const body = await response.json() as { outcome: string };

		expect(response.status).toBe(404);
		expect(body.outcome).toBe("not-found");
	});

	test("maps a conflicting runtime ownership onto the not-found transport response", async () => {
		const conversation = snapshot();
		const response = await stopRoute(
			scriptedConversation(conversation),
			scriptedRuntimes([scriptedRuntime(15, conversation.id + 500)]),
			conversation.id,
			15,
		);
		// SAFETY: this test controls the mapped not-found response shape.
		const body = await response.json() as { outcome: string };

		expect(response.status).toBe(404);
		expect(body.outcome).toBe("not-found");
	});

	test("maps an already-terminal race onto the not-found transport response", async () => {
		const conversation = snapshot();
		const response = await stopRoute(
			scriptedConversation(conversation, { invalidStop: true }),
			scriptedRuntimes([scriptedRuntime(16, conversation.id)]),
			conversation.id,
			16,
		);
		// SAFETY: this test controls the mapped not-found response shape.
		const body = await response.json() as { outcome: string };

		expect(response.status).toBe(404);
		expect(body.outcome).toBe("not-found");
	});

	test("maps an incomplete settlement onto the stopped transport response with the authoritative snapshot", async () => {
		const conversation = snapshot();
		const response = await stopRoute(
			scriptedConversation(conversation),
			scriptedRuntimes([scriptedRuntime(17, conversation.id, {
				markStoppedError: new Error("Runtime settlement exploded."),
			})]),
			conversation.id,
			17,
		);
		// SAFETY: this test controls the mapped response shape.
		const body = await response.json() as {
			outcome: string;
			generationId: number;
			conversation: { id: number };
		};

		// The durable transition committed, so the authoritative Conversation
		// snapshot is the transport truth even though runtime settlement failed.
		expect(response.status).toBe(200);
		expect(body.outcome).toBe("stopped");
		expect(body.generationId).toBe(17);
		expect(body.conversation.id).toBe(conversation.id);
	});

	test("maps a stopped Stop All onto the stopped transport response", async () => {
		const conversation = snapshot();
		const response = await stopAllRoute(
			scriptedConversation(conversation, { generationIds: [5, 6] }),
			scriptedRuntimes([scriptedRuntime(5, conversation.id), scriptedRuntime(6, conversation.id)]),
			conversation.id,
		);
		// SAFETY: this test controls the mapped response shape.
		const body = await response.json() as {
			outcome: string;
			generationIds: number[];
			conversation: { id: number };
		};

		expect(response.status).toBe(200);
		expect(body.outcome).toBe("stopped");
		expect(body.generationIds).toEqual([5, 6]);
		expect(body.conversation.id).toBe(conversation.id);
	});

	test("maps a missing Stop All onto the not-found transport response", async () => {
		const conversation = snapshot();
		const response = await stopAllRoute(
			scriptedConversation(conversation, { invalidStopAll: true }),
			scriptedRuntimes([]),
			conversation.id,
		);
		// SAFETY: this test controls the mapped not-found response shape.
		const body = await response.json() as { outcome: string };

		expect(response.status).toBe(404);
		expect(body.outcome).toBe("not-found");
	});

	test("maps an incomplete Stop All settlement onto the stopped transport response", async () => {
		const conversation = snapshot();
		const response = await stopAllRoute(
			scriptedConversation(conversation, { generationIds: [5, 6] }),
			scriptedRuntimes([
				scriptedRuntime(5, conversation.id),
				scriptedRuntime(6, conversation.id, { markStoppedError: new Error("Runtime 6 stuck.") }),
			]),
			conversation.id,
		);
		// SAFETY: this test controls the mapped response shape.
		const body = await response.json() as {
			outcome: string;
			generationIds: number[];
			conversation: { id: number };
		};

		expect(response.status).toBe(200);
		expect(body.outcome).toBe("stopped");
		expect(body.generationIds).toEqual([5, 6]);
		expect(body.conversation.id).toBe(conversation.id);
	});
});
