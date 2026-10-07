import { describe, expect, test } from "bun:test";
import {
	CONVERSATION_REVISION_UNAVAILABLE_NOTICE,
	runConversationCommand,
	type ConversationCommandCallbacks,
	type ConversationCommandNotices,
	type ConversationCommandOptions,
	type ConversationCommandReconciliation,
	type ConversationRevisionSource,
} from "./conversation-command-runner";
import type { CommandOutcome } from "./conversation";
import type { ConversationSummary } from "../shared/contract/conversation-schema";

// A minimal authoritative snapshot: the runner only forwards snapshots, so
// the fixture carries the contract shape without populating Cast details.
const summary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
	authorNote: "",
	id: 1,
	name: "Seaside Letters",
	revision: 7,
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
	...overrides,
});

// The fake reconciliation adapter records every side effect in order, so the
// tests observe adoption, notices, and their sequencing without React or
// global state.
const fakeReconciliation = (events: string[]): ConversationCommandReconciliation => ({
	adoptSnapshot: (conversation) => {
		events.push(`adopt:${conversation.revision}`);
	},
	showNotice: (notice) => {
		events.push(`notice:${notice}`);
	},
});

// The fake command resolves with the canned outcome and records the revision
// it was actually sent with.
const fakeSend = (events: string[], outcome: CommandOutcome) => async (
	expectedRevision: number,
): Promise<CommandOutcome> => {
	events.push(`send:${expectedRevision}`);
	return outcome;
};

const fakeSendThrows = (events: string[]) => async (
	expectedRevision: number,
): Promise<CommandOutcome> => {
	events.push(`send:${expectedRevision}`);
	throw new TypeError("fetch failed");
};

// The surface-owned notice wording; distinct strings prove the runner shows
// the caller's wording rather than inventing its own.
const notices: ConversationCommandNotices = {
	conflict: "conflict notice",
	notFound: "not-found notice",
	unreachable: "unreachable notice",
};

const callbacks = (events: string[], overrides: Partial<ConversationCommandCallbacks> = {}): ConversationCommandCallbacks => ({
	onNotPlayable: (reason) => {
		events.push(`not-playable:${reason}`);
	},
	onNotRemovable: (reason) => {
		events.push(`not-removable:${reason}`);
	},
	...overrides,
});

const run = (events: string[], overrides: Partial<ConversationCommandOptions> = {}): Promise<void> =>
	runConversationCommand({
		revision: () => 7,
		send: fakeSend(events, { outcome: "available", value: { outcome: "applied", conversation: summary() } }),
		reconciliation: fakeReconciliation(events),
		notices,
		callbacks: callbacks(events),
		...overrides,
	});

describe("runConversationCommand", () => {
	test("an unavailable revision refuses to send and shows the revision notice", async () => {
		const events: string[] = [];
		const revision: ConversationRevisionSource = () => null;
		await run(events, { revision, send: fakeSend(events, { outcome: "network" }) });
		expect(events).toEqual([`notice:${CONVERSATION_REVISION_UNAVAILABLE_NOTICE}`]);
	});

	test("the command is sent with the authoritative revision from the source", async () => {
		const events: string[] = [];
		await run(events, { revision: () => 41 });
		expect(events[0]).toBe("send:41");
	});

	test("an applied command adopts the applied snapshot before the applied callback", async () => {
		const events: string[] = [];
		const applied = summary({ revision: 8 });
		await run(events, {
			send: fakeSend(events, { outcome: "available", value: { outcome: "applied", conversation: applied } }),
			callbacks: callbacks(events, {
				onApplied: (conversation) => {
					events.push("applied-callback");
					expect(conversation).toBe(applied);
				},
			}),
		});
		expect(events).toEqual(["send:7", "adopt:8", "applied-callback"]);
	});

	test("an applied command without an applied callback only adopts the snapshot", async () => {
		const events: string[] = [];
		await run(events, { callbacks: callbacks(events, { onApplied: undefined }) });
		expect(events).toEqual(["send:7", "adopt:7"]);
	});

	test("a conflict adopts the current Conversation, shows the conflict notice, and calls the conflict callback", async () => {
		const events: string[] = [];
		const current = summary({ revision: 9 });
		await run(events, {
			send: fakeSend(events, { outcome: "conflict", expectedRevision: 7, actualRevision: 9, currentConversation: current }),
			callbacks: callbacks(events, {
				onConflict: (conversation) => {
					events.push("conflict-callback");
					expect(conversation).toBe(current);
				},
			}),
		});
		expect(events).toEqual(["send:7", "adopt:9", "notice:conflict notice", "conflict-callback"]);
	});

	test("a conflict without a conflict callback still adopts and shows the notice", async () => {
		const events: string[] = [];
		await run(events, {
			send: fakeSend(events, { outcome: "conflict", expectedRevision: 7, actualRevision: 9, currentConversation: summary({ revision: 9 }) }),
			callbacks: callbacks(events, { onConflict: undefined }),
		});
		expect(events).toEqual(["send:7", "adopt:9", "notice:conflict notice"]);
	});

	test("an invalid outcome shows the server reason without adopting any snapshot", async () => {
		const events: string[] = [];
		await run(events, {
			send: fakeSend(events, { outcome: "invalid", reason: "Continuation instruction is required." }),
		});
		expect(events).toEqual(["send:7", "notice:Continuation instruction is required."]);
	});

	test("a not-found outcome shows the caller-owned not-found notice", async () => {
		const events: string[] = [];
		await run(events, { send: fakeSend(events, { outcome: "not-found" }) });
		expect(events).toEqual(["send:7", "notice:not-found notice"]);
	});

	test("a network outcome shows the caller-owned unreachable notice", async () => {
		const events: string[] = [];
		await run(events, { send: fakeSend(events, { outcome: "network" }) });
		expect(events).toEqual(["send:7", "notice:unreachable notice"]);
	});

	test("a thrown send is normalized to the network outcome", async () => {
		const events: string[] = [];
		await run(events, { send: fakeSendThrows(events) });
		expect(events).toEqual(["send:7", "notice:unreachable notice"]);
	});

	test("not-playable keeps its precise meaning through the typed callback", async () => {
		const events: string[] = [];
		await run(events, {
			send: fakeSend(events, { outcome: "not-playable", reason: "The Conversation is not playable." }),
		});
		expect(events).toEqual(["send:7", "not-playable:The Conversation is not playable."]);
	});

	test("not-removable keeps its precise meaning through the typed callback", async () => {
		const events: string[] = [];
		await run(events, {
			send: fakeSend(events, { outcome: "not-removable", reason: "This Participant is seated." }),
		});
		expect(events).toEqual(["send:7", "not-removable:This Participant is seated."]);
	});

	test("an operation outcome is forwarded untouched to the typed operation callback", async () => {
		const events: string[] = [];
		type SavedOperation = {
			kind: "participant-saved";
			character: { id: number; name: string };
		};
		const operation: SavedOperation = {
			kind: "participant-saved",
			character: { id: 3, name: "Juno Ashfeld" },
		};
		await runConversationCommand<{ kind: "participant-saved"; character: { id: number; name: string } }>({
			revision: () => 7,
			send: async (expectedRevision) => {
				events.push(`send:${expectedRevision}`);
				return { outcome: "operation", operation };
			},
			reconciliation: fakeReconciliation(events),
			notices,
			callbacks: {
				onNotPlayable: () => events.push("unexpected-not-playable"),
				onNotRemovable: () => events.push("unexpected-not-removable"),
				onOperation: (forwarded) => {
					events.push("operation-callback");
					expect(forwarded).toBe(operation);
				},
			},
		});
		expect(events).toEqual(["send:7", "operation-callback"]);
	});

	test("an operation outcome triggers no adoption and no notice", async () => {
		const events: string[] = [];
		await runConversationCommand<{ kind: string }>({
			revision: () => 7,
			send: async (expectedRevision) => {
				events.push(`send:${expectedRevision}`);
				return { outcome: "operation", operation: { kind: "character-changed" } };
			},
			reconciliation: fakeReconciliation(events),
			notices,
			callbacks: {
				onNotPlayable: () => events.push("unexpected-not-playable"),
				onNotRemovable: () => events.push("unexpected-not-removable"),
				onOperation: () => undefined,
			},
		});
		expect(events).toEqual(["send:7"]);
	});
});
