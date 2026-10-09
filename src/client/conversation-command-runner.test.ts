import { describe, expect, test } from "bun:test";
import {
	CONVERSATION_REVISION_UNAVAILABLE_NOTICE,
	runConversationCommand,
	type ConversationCommandRunOptions,
	type ConversationCommandSend,
	type ConversationCommandSurface,
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

// The fake surface records every side effect in order, so the tests observe
// adoption, notices, and their sequencing without React or global state.
const surface = (events: string[], overrides: Partial<ConversationCommandSurface> = {}): ConversationCommandSurface => ({
	conversationId: 1,
	revision: () => 7,
	onConversationChange: (conversation) => {
		events.push(`adopt:${conversation.revision}`);
	},
	setNotice: (notice) => {
		events.push(`notice:${notice}`);
	},
	...overrides,
});

// The fake command resolves with the canned outcome and records the revision
// it was actually sent with.
const fakeSend = (events: string[], outcome: CommandOutcome): ConversationCommandSend => async (
	expectedRevision: number,
): Promise<CommandOutcome> => {
	events.push(`send:${expectedRevision}`);
	return outcome;
};

const applied = (events: string[]) =>
	fakeSend(events, { outcome: "available", value: { outcome: "applied", conversation: summary() } });

const fakeSendThrows = (events: string[]): ConversationCommandSend => async (
	expectedRevision: number,
): Promise<CommandOutcome> => {
	events.push(`send:${expectedRevision}`);
	throw new TypeError("fetch failed");
};

// The surface-owned notice wording; distinct strings prove the runner shows
// the caller's wording rather than inventing its own.
const notices = {
	conflict: "conflict notice",
	notFound: "not-found notice",
	unreachable: "unreachable notice",
};

const run = (
	events: string[],
	send: ConversationCommandSend,
	options: ConversationCommandRunOptions = {},
	surfaceOverrides: Partial<ConversationCommandSurface> = {},
): Promise<void> => runConversationCommand(surface(events, surfaceOverrides), send, { notices, ...options });

describe("runConversationCommand", () => {
	test("an unavailable revision refuses to send and shows the revision notice", async () => {
		const events: string[] = [];
		await runConversationCommand(
			surface(events, { revision: () => null }),
			fakeSend(events, { outcome: "network" }),
		);
		expect(events).toEqual([`notice:${CONVERSATION_REVISION_UNAVAILABLE_NOTICE}`]);
	});

	test("the command is sent with the authoritative revision from the source", async () => {
		const events: string[] = [];
		await run(events, applied(events), {}, { revision: () => 41 });
		expect(events[0]).toBe("send:41");
	});

	test("an applied command adopts the applied snapshot before the applied callback", async () => {
		const events: string[] = [];
		const appliedSnapshot = summary({ revision: 8 });
		await run(events, fakeSend(events, { outcome: "available", value: { outcome: "applied", conversation: appliedSnapshot } }), {
			onApplied: (conversation) => {
				events.push("applied-callback");
				expect(conversation).toBe(appliedSnapshot);
			},
		});
		expect(events).toEqual(["send:7", "adopt:8", "applied-callback"]);
	});

	test("an applied command without an applied callback only adopts the snapshot", async () => {
		const events: string[] = [];
		await run(events, applied(events));
		expect(events).toEqual(["send:7", "adopt:7"]);
	});

	test("a conflict adopts the current Conversation, shows the conflict notice, and calls the conflict callback", async () => {
		const events: string[] = [];
		const current = summary({ revision: 9 });
		await run(events, fakeSend(events, { outcome: "conflict", expectedRevision: 7, actualRevision: 9, currentConversation: current }), {
			onConflict: (conversation) => {
				events.push("conflict-callback");
				expect(conversation).toBe(current);
			},
		});
		expect(events).toEqual(["send:7", "adopt:9", "notice:conflict notice", "conflict-callback"]);
	});

	test("a conflict without a conflict callback still adopts and shows the notice", async () => {
		const events: string[] = [];
		await run(events, fakeSend(events, { outcome: "conflict", expectedRevision: 7, actualRevision: 9, currentConversation: summary({ revision: 9 }) }));
		expect(events).toEqual(["send:7", "adopt:9", "notice:conflict notice"]);
	});

	test("an invalid outcome shows the server reason without adopting any snapshot", async () => {
		const events: string[] = [];
		await run(events, fakeSend(events, { outcome: "invalid", reason: "Continuation instruction is required." }));
		expect(events).toEqual(["send:7", "notice:Continuation instruction is required."]);
	});

	test("a not-found outcome shows the caller-owned not-found notice", async () => {
		const events: string[] = [];
		await run(events, fakeSend(events, { outcome: "not-found" }));
		expect(events).toEqual(["send:7", "notice:not-found notice"]);
	});

	test("a network outcome shows the caller-owned unreachable notice", async () => {
		const events: string[] = [];
		await run(events, fakeSend(events, { outcome: "network" }));
		expect(events).toEqual(["send:7", "notice:unreachable notice"]);
	});

	test("a thrown send is normalized to the network outcome", async () => {
		const events: string[] = [];
		await run(events, fakeSendThrows(events));
		expect(events).toEqual(["send:7", "notice:unreachable notice"]);
	});

	test("not-playable keeps its precise meaning through the typed callback", async () => {
		const events: string[] = [];
		await run(events, fakeSend(events, { outcome: "not-playable", reason: "The Conversation is not playable." }), {
			onNotPlayable: (reason) => {
				events.push(`not-playable:${reason}`);
			},
		});
		expect(events).toEqual(["send:7", "not-playable:The Conversation is not playable."]);
	});

	test("not-removable keeps its precise meaning through the typed callback", async () => {
		const events: string[] = [];
		await run(events, fakeSend(events, { outcome: "not-removable", reason: "This Participant is seated." }), {
			onNotRemovable: (reason) => {
				events.push(`not-removable:${reason}`);
			},
		});
		expect(events).toEqual(["send:7", "not-removable:This Participant is seated."]);
	});

	test("not-playable and not-removable default to the surface notice", async () => {
		const events: string[] = [];
		await run(events, fakeSend(events, { outcome: "not-playable", reason: "The Conversation is not playable." }));
		await run(events, fakeSend(events, { outcome: "not-removable", reason: "This Participant is seated." }));
		expect(events).toEqual([
			"send:7",
			"notice:The Conversation is not playable.",
			"send:7",
			"notice:This Participant is seated.",
		]);
	});

	test("a superseded surface adopts nothing and shows no notice", async () => {
		const events: string[] = [];
		await run(events, applied(events), {}, { isCurrent: () => false });
		expect(events).toEqual(["send:7"]);
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
		await runConversationCommand<SavedOperation>(surface(events), async (expectedRevision) => {
			events.push(`send:${expectedRevision}`);
			return { outcome: "operation", operation };
		}, {
			notices,
			onOperation: (forwarded) => {
				events.push("operation-callback");
				expect(forwarded).toBe(operation);
			},
		});
		expect(events).toEqual(["send:7", "operation-callback"]);
	});

	test("an operation outcome triggers no adoption and no notice", async () => {
		const events: string[] = [];
		await runConversationCommand<{ kind: string }>(surface(events), async (expectedRevision) => {
			events.push(`send:${expectedRevision}`);
			return { outcome: "operation", operation: { kind: "character-changed" } };
		}, {
			notices,
			onOperation: () => undefined,
		});
		expect(events).toEqual(["send:7"]);
	});
});
