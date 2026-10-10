import { afterEach, describe, expect, test } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import type { ChatHistoryPage } from "../chat-history";
import type { StoryAction, StoryState } from "../story";
import type { ConversationSummary } from "../../shared/contract/conversation-schema";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { useStoryMessageActions } = await import("./useStoryMessageActions");
const { createStoryState, displayedVariantId, reduceStory } = await import("../story");

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// A Swipe on the final Message shows its Variant at once as a Requested selection; the persisted selection
// moves only when select-variant applies, and a refused command returns the view to the server's Variant.
// The seam under test is the hook's changeSwipe against a fake Conversation command transport plus the real
// story reducer, wired per call exactly like the workspace does per render.

const summary = (revision: number): ConversationSummary => ({
	authorNote: "",
	id: 1,
	name: "Seaside Letters",
	revision,
	cast: [],
	control: { humanParticipantId: 10, modelParticipantId: 20 },
	controlValidity: { valid: true, reason: null },
	playable: true,
	capabilities: {
		compose: { available: true, reason: null },
		generate: { available: true, reason: null },
		swipe: { available: true, reason: null },
	},
	activeGenerations: [],
});

const firstPage = (withLaterMessage = false): ChatHistoryPage => ({
	conversationId: 1,
	name: "Seaside Letters",
	revision: 5,
	cast: [
		{ id: 10, position: 1, name: "Writer" },
		{ id: 20, position: 2, name: "Model" },
	],
	page: {
		index: 1,
		pageSize: 10,
		totalMessages: withLaterMessage ? 2 : 1,
		totalPages: 1,
		hasOlder: false,
		hasNewer: false,
	},
	messages: [{
		id: 10,
		position: 1,
		timestamp: "2026-01-01T00:00:00.000Z",
		modelParticipantIdAtCreation: null,
		continuable: true,
		swipe: { eligible: true, reason: null },
		author: { participantId: 20, capturedName: "Author", inCast: true },
		variants: [
			{ id: 100, position: 1, content: "First", timestamp: "2026-01-01T00:00:00.000Z", selected: true },
			{ id: 101, position: 2, content: "Second", timestamp: "2026-01-01T00:00:01.000Z", selected: false },
			{ id: 102, position: 3, content: "Third", timestamp: "2026-01-01T00:00:02.000Z", selected: false },
			{ id: 103, position: 4, content: "Fourth", timestamp: "2026-01-01T00:00:03.000Z", selected: false },
		],
	}, ...(withLaterMessage ? [{
		id: 11,
		position: 2,
		timestamp: "2026-01-01T00:00:03.000Z",
		modelParticipantIdAtCreation: null,
		continuable: true,
		swipe: { eligible: true as const, reason: null },
		author: { participantId: 10, capturedName: "Writer", inCast: true },
		variants: [{ id: 110, position: 1, content: "Later", timestamp: "2026-01-01T00:00:03.000Z", selected: true }],
	}] : [])],
});

// The concrete wire failure payloads the command route serves for a
// select-variant that does not apply; the fake transport serves them verbatim.
type FailureOutcomePayload =
	| { outcome: "not-found" }
	| { outcome: "invalid"; reason: string }
	| { outcome: "not-playable"; reason: string }
	| { outcome: "not-removable"; reason: string };

type CommandMode =
	| { kind: "applied" }
	| { kind: "conflict" }
	| { kind: "network" }
	| { kind: "outcome"; status: number; payload: FailureOutcomePayload };

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type RecordedCommand = {
	expectedRevision: number;
	action: { type: string; messageId?: number; variantId?: number };
};

function createHarness(mode: CommandMode, withLaterMessage = false) {
	const events: string[] = [];
	const commands: RecordedCommand[] = [];
	const fetches: { method: string; url: string }[] = [];
	let revision = 5;
	let gate: Promise<void> = Promise.resolve();

	const handler: FetchHandler = async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const method = init?.method ?? "GET";
		fetches.push({ method, url });
		if (method === "POST" && url.endsWith("/api/conversations/1/commands")) {
			await gate;
			if (mode.kind === "network") throw new TypeError("fetch failed");
			if (mode.kind === "outcome") {
				return Response.json(mode.payload, { status: mode.status });
			}
			// SAFETY: the test's own command posts serialize the typed command
			// body to JSON, so parsing the recorded body restores that shape.
			const body = JSON.parse(String(init?.body)) as RecordedCommand;
			commands.push(body);
			events.push(`send:${body.expectedRevision}`);
			if (mode.kind === "conflict") {
				// The server kept its own selection and returns the current
				// Conversation at the unchanged revision.
				return Response.json(
					{ outcome: "conflict", currentConversation: summary(revision) },
					{ status: 409 },
				);
			}
			if (body.expectedRevision !== revision) {
				return Response.json(
					{ outcome: "conflict", currentConversation: summary(revision) },
					{ status: 409 },
				);
			}
			revision += 1;
			return Response.json({ outcome: "applied", conversation: summary(revision) });
		}
		return new Response(null, { status: 404 });
	};
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });

	let story: StoryState = reduceStory(
		reduceStory(createStoryState(), { type: "chat-opened", conversationId: 1 }),
		{ type: "window-received", page: firstPage(withLaterMessage) },
	);
	let conversation: ConversationSummary | null = summary(5);

	const dispatchStory = (action: StoryAction) => {
		events.push(`action:${action.type}`);
		story = reduceStory(story, action);
	};
	// SAFETY: the runner adopts snapshots by value on this seam; the wider
	// SetStateAction function shape is never produced by any caller here.
	const setConversation = ((value: ConversationSummary | null) => {
		conversation = value;
		events.push(`adopt:${value?.revision ?? "cleared"}`);
	}) as Dispatch<SetStateAction<ConversationSummary | null>>;

	const swipe = (messageId: number, direction: -1 | 1) =>
		useStoryMessageActions({
			signal: new AbortController().signal,
			story,
			conversation,
			dispatchStory,
			setConversation,
			queueSwipeScroll: (target) => {
				events.push(`scroll:${target}`);
			},
			canEnterPreview: true,
			onEnterPreview: () => {
				events.push("enter-preview");
			},
		}).changeSwipe(messageId, direction);

	const activeVariantId = (): number | null => {
		const message = story.messages.find((entry) => entry.id === 10);
		// SAFETY: the fixture above gave the Message exactly the four Variants
		// every assertion in this file reads between.
		return message?.swipes[message.activeSwipe]?.id ?? null;
	};
	const shownVariantId = (): number | null => {
		const message = story.messages.find((entry) => entry.id === 10);
		return message === undefined ? null : displayedVariantId(message, story.preview, story.requestedSelection);
	};
	const hold = () => {
		const release = Promise.withResolvers<void>();
		gate = release.promise;
		return release.resolve;
	};

	return {
		events,
		commands,
		fetches,
		swipe,
		activeVariantId,
		shownVariantId,
		hold,
		story: () => story,
		conversation: () => conversation,
	};
}

describe("Requested selection", () => {
	test("a Swipe shows its Variant at once and persists it when the command applies", async () => {
		const harness = createHarness({ kind: "applied" });
		const release = harness.hold();

		const swiping = harness.swipe(10, 1);

		expect(harness.shownVariantId()).toBe(101);
		expect(harness.activeVariantId()).toBe(100);
		release();
		await swiping;
		expect(harness.commands).toEqual([
			{ expectedRevision: 5, action: { type: "select-variant", messageId: 10, variantId: 101 } },
		]);
		expect(harness.activeVariantId()).toBe(101);
		expect(harness.story().requestedSelection).toBeNull();
		// No history read rides along: the Swipe applies from the already loaded Variants.
		expect(harness.fetches).toEqual([
			{ method: "POST", url: "http://localhost/api/conversations/1/commands" },
		]);
	});

	test("rapid Swipes send only the latest Variant, on the revision the first one produced", async () => {
		const harness = createHarness({ kind: "applied" });
		const release = harness.hold();

		const first = harness.swipe(10, 1);
		await Bun.sleep(0);
		expect(harness.fetches).toHaveLength(1);
		const swipes = [first, harness.swipe(10, 1), harness.swipe(10, 1)];

		expect(harness.shownVariantId()).toBe(103);
		release();
		await Promise.all(swipes);
		expect(harness.commands).toEqual([
			{ expectedRevision: 5, action: { type: "select-variant", messageId: 10, variantId: 101 } },
			{ expectedRevision: 6, action: { type: "select-variant", messageId: 10, variantId: 103 } },
		]);
		expect(harness.activeVariantId()).toBe(103);
		expect(harness.shownVariantId()).toBe(103);
	});

	test("a conflicted Swipe returns to the Variant the server kept", async () => {
		const harness = createHarness({ kind: "conflict" });

		await harness.swipe(10, 1);

		expect(harness.conversation()?.revision).toBe(5);
		expect(harness.shownVariantId()).toBe(100);
		expect(harness.story().requestedSelection).toBeNull();
	});

	test("every other refused or unreachable Swipe returns to the server's Variant", async () => {
		const modes: CommandMode[] = [
			{ kind: "network" },
			{ kind: "outcome", status: 404, payload: { outcome: "not-found" } },
			{ kind: "outcome", status: 422, payload: { outcome: "invalid", reason: "Unknown Variant." } },
			{ kind: "outcome", status: 409, payload: { outcome: "not-playable", reason: "The Conversation is not playable." } },
			{ kind: "outcome", status: 409, payload: { outcome: "not-removable", reason: "This Variant is removable only through Remove." } },
		];
		for (const mode of modes) {
			const harness = createHarness(mode);

			await harness.swipe(10, 1);

			expect(harness.shownVariantId()).toBe(100);
			expect(harness.activeVariantId()).toBe(100);
			expect(harness.events).not.toContain("action:swipe-selected");
		}
	});

	test("a Swipe with later Messages previews locally without a command", async () => {
		const harness = createHarness({ kind: "applied" }, true);

		await harness.swipe(10, 1);

		expect(harness.commands).toEqual([]);
		expect(harness.events).toContain("enter-preview");
		expect(harness.story().preview?.variantId).toBe(101);
		// The stored selection stays untouched while Preview mode is active.
		expect(harness.activeVariantId()).toBe(100);

		await harness.swipe(10, 1);

		expect(harness.commands).toEqual([]);
		expect(harness.story().preview?.variantId).toBe(102);
		expect(harness.activeVariantId()).toBe(100);
	});
});
