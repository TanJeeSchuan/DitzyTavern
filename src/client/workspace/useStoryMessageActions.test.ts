import { queueConversationCommand } from "../conversation-command-runner";
import { historyVariant, historyMessage, historyPage, conversationSummary, installFetch, type FetchHandler } from "../test-fixtures/conversation";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatHistoryPage } from "../chat-history";
import type { StoryAction } from "../story";
import type { ConversationSummary } from "../../shared/contract/conversation-schema";

const originalFetch = globalThis.fetch;
const { useStoryMessageActions } = await import("./useStoryMessageActions");
const { usePreviewController } = await import("./usePreviewController");
const { createStoryOverlays, displayedVariantId, readStory, reduceStoryOverlays, retireStoryOverlays, toStoryMessage } = await import("../story");

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const summary = (revision: number): ConversationSummary => conversationSummary({
	revision,
	control: { humanParticipantId: 10, modelParticipantId: 20 },
	controlValidity: { valid: true, reason: null },
	playable: true,
	capabilities: {
		compose: { available: true, reason: null },
		generate: { available: true, reason: null },
		swipe: { available: true, reason: null },
	},
});

const firstPage = (withLaterMessage = false): ChatHistoryPage => historyPage({
	conversationId: 1,
	name: "Seaside Letters",
	revision: 5,
	cast: [
		{ id: 10, position: 1, name: "Writer" },
		{ id: 20, position: 2, name: "Model" },
	],
	page: { pageSize: 10, totalMessages: withLaterMessage ? 2 : 1, totalPages: 1, hasOlder: false },
	messages: [historyMessage({
		author: { participantId: 20, capturedName: "Author", inCast: true },
		variants: [
			historyVariant({ content: "First" }),
			historyVariant({ id: 101, position: 2, content: "Second", timestamp: "2026-01-01T00:00:01.000Z", selected: false }),
			historyVariant({ id: 102, position: 3, content: "Third", timestamp: "2026-01-01T00:00:02.000Z", selected: false }),
			historyVariant({ id: 103, position: 4, content: "Fourth", timestamp: "2026-01-01T00:00:03.000Z", selected: false }),
		],
	}), ...(withLaterMessage ? [historyMessage({
		id: 11,
		position: 2,
		timestamp: "2026-01-01T00:00:03.000Z",
		authorRole: "human",
		author: { participantId: 10, capturedName: "Writer", inCast: true },
		variants: [
			historyVariant({ id: 110, content: "Later", timestamp: "2026-01-01T00:00:03.000Z" }),
			historyVariant({ id: 111, position: 2, selected: false }),
		],
	})] : [])],
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

type RecordedCommand = {
	expectedRevision: number;
	action: { type: string; messageId?: number; variantId?: number };
};

function createHarness(mode: CommandMode, withLaterMessage = false) {
	let previewEntries = 0;
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
			if (mode.kind === "conflict") revision += 1;
			if (body.expectedRevision !== revision) {
				return Response.json(
					{ outcome: "conflict", reason: "stale-revision", expectedRevision: body.expectedRevision, actualRevision: revision, current: summary(revision) },
					{ status: 409 },
				);
			}
			revision += 1;
			return Response.json({ outcome: "applied", conversation: summary(revision) });
		}
		return new Response(null, { status: 404 });
	};
	installFetch(handler);

	let overlays = createStoryOverlays();
	const initial = firstPage(withLaterMessage);
	let window = { revision: initial.revision, page: initial.page, messages: initial.messages.map(toStoryMessage) };
	let conversation: ConversationSummary | null = summary(5);

	const story = () => readStory({ overlays, window, conversationId: 1, historyFailed: false, loadingMore: false });
	const dispatchStory = (action: StoryAction) => {
		overlays = retireStoryOverlays(reduceStoryOverlays(overlays, action), window, conversation);
	};
	const setConversation = (value: ConversationSummary | null) => {
		conversation = value;
	};
	const publishHistory = (variantId: number) => {
		const page = initial.messages.map((message) => message.id === 10 ? {
			...message, variants: message.variants.map((variant) => ({ ...variant, selected: variant.id === variantId })),
		} : message);
		window = { ...window, revision, messages: page.map(toStoryMessage) };
		overlays = retireStoryOverlays(overlays, window, conversation);
	};

	const visit = new AbortController();
	const surface = () => ({
		signal: visit.signal,
		story: story(),
		dispatchStory,
		setConversation,
	});
	const actions = () => useStoryMessageActions({
		...surface(),
		queueSwipeScroll() {},
		canEnterPreview: true,
		onEnterPreview: (enter) => {
			previewEntries++;
			enter();
		},
	});
	const swipe = (messageId: number, direction: -1 | 1) => actions().changeSwipe(messageId, direction);
	const edit = (messageId: number, content: string) => actions().editStoryMessage(messageId, content, false, window.revision);

	const activeVariantId = (): number | null => {
		const message = window.messages.find((entry) => entry.id === 10);
		// SAFETY: the fixture above gave the Message exactly the four Variants
		// every assertion in this file reads between.
		return message?.swipes[message.activeSwipe]?.id ?? null;
	};
	const shownVariantId = (): number | null => {
		const message = window.messages.find((entry) => entry.id === 10);
		return message === undefined ? null : displayedVariantId(story(), message);
	};
	const hold = () => {
		const release = Promise.withResolvers<void>();
		gate = release.promise;
		return release.resolve;
	};

	return {
		previewEntries: () => previewEntries,
		commands,
		fetches,
		swipe,
		edit,
		select: (messageId: number, variantId: number) => actions().selectSwipe(messageId, variantId),
		confirm: () => usePreviewController(surface()).confirmPreview(),
		activeVariantId,
		shownVariantId,
		hold,
		story,
		publishHistory,
		appendMessage: () => {
			revision++;
			conversation = summary(revision);
			window = { ...window, revision, messages: firstPage(true).messages.map(toStoryMessage) };
		},
		conversation: () => conversation,
	};
}

describe("Requested selection", () => {
	test("a Swipe stays visible after acceptance until history reflects it", async () => {
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
		expect(harness.activeVariantId()).toBe(100);
		expect(harness.shownVariantId()).toBe(101);
		harness.publishHistory(101);
		expect(harness.shownVariantId()).toBe(101);
		harness.publishHistory(102);
		expect(harness.shownVariantId()).toBe(102);
	});

	test("rapid Swipes coalesce without borrowing the preceding write revision", async () => {
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
			{ expectedRevision: 5, action: { type: "select-variant", messageId: 10, variantId: 103 } },
		]);
		expect(harness.shownVariantId()).toBe(101);
		harness.publishHistory(102);
		expect(harness.shownVariantId()).toBe(102);
	});

	test("an edit made while a Swipe waits edits the Variant on screen", async () => {
		const harness = createHarness({ kind: "applied" });
		const release = harness.hold();

		const swiping = harness.swipe(10, 1);
		const editing = harness.edit(10, "Second, revised");
		release();
		await Promise.all([swiping, editing]);

		expect(harness.commands.map(({ action }) => [action.type, action.variantId])).toEqual([
			["select-variant", 101],
			["edit-variant", 101],
		]);
	});

	test("a conflicted Swipe returns to the Variant the server kept", async () => {
		const harness = createHarness({ kind: "conflict" });

		await harness.swipe(10, 1);

		expect(harness.conversation()?.revision).toBe(6);
		expect(harness.shownVariantId()).toBe(100);
		harness.publishHistory(102);
		expect(harness.shownVariantId()).toBe(102);
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
		}
	});

	test("Preview blocks a later Swipe and sends only the older Variant confirmed by the writer", async () => {
		const harness = createHarness({ kind: "applied" }, true);

		await harness.swipe(10, 1);

		expect(harness.commands).toEqual([]);
		expect(harness.previewEntries()).toBe(1);
		expect(harness.story().preview?.variantId).toBe(101);
		// The stored selection stays untouched while Preview mode is active.
		expect(harness.activeVariantId()).toBe(100);

		await harness.swipe(10, 1);

		expect(harness.commands).toEqual([]);
		expect(harness.story().preview?.variantId).toBe(102);
		expect(harness.activeVariantId()).toBe(100);
		await harness.select(11, 111);
		expect(harness.commands).toEqual([]);
		expect(harness.story().preview?.variantId).toBe(102);

		await harness.confirm();
		expect(harness.commands).toEqual([
			{ expectedRevision: 5, action: { type: "select-variant", messageId: 10, variantId: 102 } },
		]);
		expect(harness.story().preview).toBeNull();
		expect(harness.shownVariantId()).toBe(102);
		harness.publishHistory(101);
		expect(harness.shownVariantId()).toBe(101);
	});
});


test("coalescing Swipes across Messages retires the displaced unsent selection", async () => {
	const harness = createHarness({ kind: "applied" });
	const gate = Promise.withResolvers<void>();
	const blocker = queueConversationCommand(1, async () => { await gate.promise; return false; });
	const first = harness.select(10, 101);
	expect(harness.shownVariantId()).toBe(101);
	harness.appendMessage();
	const second = harness.select(11, 111);
	gate.resolve();
	await Promise.all([blocker, first, second]);
	expect(harness.commands).toEqual([
		{ expectedRevision: 6, action: { type: "select-variant", messageId: 11, variantId: 111 } },
	]);
	harness.publishHistory(100);
	expect(harness.shownVariantId()).toBe(100);
	harness.publishHistory(102);
	expect(harness.shownVariantId()).toBe(102);
});
