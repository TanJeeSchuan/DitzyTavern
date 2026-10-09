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
const { createStoryState, reduceStory } = await import("../story");

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// The failed-optimistic-Swipe divergence regression: the story read model and
// the Conversation snapshot are two state owners, and a failed or conflicted
// select-variant command must leave them consistent. The seam under test is
// the hook's changeSwipe against a fake Conversation command transport plus
// the real story reducer, wired per call exactly like the workspace does per
// render. The applied and Preview tests guard the success path: the Swipe
// still applies from the already loaded Variants with no extra read.

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

	const handler: FetchHandler = async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const method = init?.method ?? "GET";
		fetches.push({ method, url });
		if (method === "POST" && url.endsWith("/api/conversations/1/commands")) {
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
		{ type: "first-page", page: firstPage(withLaterMessage) },
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
			refreshHistoryPage: async () => {},
			story,
			conversation,
			dispatchStory,
			setConversation,
			queueSwipeScroll: (target) => {
				events.push(`scroll:${target}`);
			},
			clearPreviewError: () => {
				events.push("preview-error-cleared");
			},
			canEnterPreview: true,
			onEnterPreview: () => {
				events.push("enter-preview");
			},
		}).changeSwipe(messageId, direction);

	const activeVariantId = (): number | null => {
		const message = story.messages.find((entry) => entry.id === 10);
		// SAFETY: the fixture above gave the Message exactly the three Variants
		// every assertion in this file reads between.
		return message?.swipes[message.activeSwipe]?.id ?? null;
	};

	return {
		events,
		commands,
		fetches,
		swipe,
		activeVariantId,
		story: () => story,
		conversation: () => conversation,
	};
}

describe("optimistic Swipe reconciliation", () => {
	test("a conflicted Swipe never moves the story selection", async () => {
		const harness = createHarness({ kind: "conflict" });

		await harness.swipe(10, 1);

		// The command reached the server, and the canonical conflict reload
		// adopted the current Conversation; the server kept Variant 100.
		expect(harness.commands).toEqual([
			{ expectedRevision: 5, action: { type: "select-variant", messageId: 10, variantId: 101 } },
		]);
		expect(harness.conversation()?.revision).toBe(5);
		// The story read model stays exactly where the Conversation is: the
		// selection never moved because the command never applied.
		expect(harness.activeVariantId()).toBe(100);
	});

	test("an unreachable server never moves the story selection", async () => {
		const harness = createHarness({ kind: "network" });

		await harness.swipe(10, 1);

		expect(harness.activeVariantId()).toBe(100);
	});

	test("every other non-applied outcome leaves the story selection unmoved", async () => {
		// The remaining typed command failures — with the server statuses the
		// command route returns — never carry an applied selection, so the story
		// read model must stay exactly as the Conversation state is.
		const outcomes: {
			status: number;
			payload: FailureOutcomePayload;
		}[] = [
			{ status: 404, payload: { outcome: "not-found" } },
			{ status: 422, payload: { outcome: "invalid", reason: "Unknown Variant." } },
			{
				status: 409,
				payload: { outcome: "not-playable", reason: "The Conversation is not playable." },
			},
			{
				status: 409,
				payload: { outcome: "not-removable", reason: "This Variant is removable only through Remove." },
			},
		];
		for (const outcome of outcomes) {
			const harness = createHarness({ kind: "outcome", ...outcome });

			await harness.swipe(10, 1);

			expect(harness.activeVariantId()).toBe(100);
			expect(harness.events).not.toContain("action:swipe-selected");
		}
	});

	test("an applied Swipe moves the story only after the command succeeds", async () => {
		const harness = createHarness({ kind: "applied" });

		await harness.swipe(10, 1);

		expect(harness.commands).toEqual([
			{ expectedRevision: 5, action: { type: "select-variant", messageId: 10, variantId: 101 } },
		]);
		// Update-after-success: the story update follows the send and the
		// applied snapshot adoption, never precedes them.
		expect(harness.events.indexOf("send:5")).toBeLessThan(
			harness.events.indexOf("action:swipe-selected"),
		);
		expect(harness.events).toContain("adopt:6");
		expect(harness.activeVariantId()).toBe(101);
		// No history read rides along: the Swipe applies from the already
		// loaded Variants, so the success path cannot flicker (DESIGN.md).
		expect(harness.fetches).toEqual([
			{ method: "POST", url: "http://localhost/api/conversations/1/commands" },
		]);
	});

	test("the next Swipe commands the revision adopted from the previous application", async () => {
		const harness = createHarness({ kind: "applied" });

		await harness.swipe(10, 1);
		await harness.swipe(10, 1);

		// The selection walks 100 → 101 → 102 across two applied commands, the
		// second based on the revision the first application adopted.
		expect(harness.commands).toEqual([
			{ expectedRevision: 5, action: { type: "select-variant", messageId: 10, variantId: 101 } },
			{ expectedRevision: 6, action: { type: "select-variant", messageId: 10, variantId: 102 } },
		]);
		expect(harness.activeVariantId()).toBe(102);
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
