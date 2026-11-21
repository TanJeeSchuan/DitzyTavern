import { describe, expect, test } from "bun:test";
import { toStoryMessage, type StoryMessage, type StoryVariant } from "../story";
import type { ChatHistoryPage } from "../chat-history";
import { historyMessage as message, historyPage as page, historyVariant } from "../test-fixtures/conversation";
import { createVariantStreamReader, createVariantStreams, streamedVariant, type VariantObservation } from "./variant-streams";

const checkpoint = (lastEventId: number, content: string, reasoning = ""): StoryVariant => ({
	id: 100, position: 1, content, reasoning, hasReasoning: reasoning !== "", empty: content === "", generationId: 55, lastEventId,
});
const append = (eventId: number, text: string): VariantObservation => ({
	messageId: 10, variantId: 100, generationId: 55, eventId, mode: "append", stream: "content", text,
});

describe("Variant stream checkpoints", () => {
	test("a newer page checkpoint survives leaving the window before the next delta", () => {
		const streams = createVariantStreams();
		streams.observe(append(1, "One."), checkpoint(0, ""));
		const page = checkpoint(2, "One. Two.", "New thought");
		streams.checkpoint([page]);
		// Reject showing the older stream instead of the newer page while it is visible.
		expect(streamedVariant(page, streams.get(100)).content).toBe("One. Two.");
		streams.checkpoint([]);
		streams.observe(append(3, " Three."), undefined);
		// Reject appending to event 1 after navigation discarded the event-2 page.
		expect(streamedVariant(page, streams.get(100))).toMatchObject({ content: "One. Two. Three.", reasoning: "New thought", lastEventId: 3 });
	});

	test("a live checkpoint seeds text before any delta, and an older page cannot rewind it", () => {
		const streams = createVariantStreams();
		streams.checkpoint([checkpoint(2, "One. Two.")]);
		streams.checkpoint([checkpoint(1, "One.")]);
		streams.checkpoint([]);
		streams.observe(append(3, " Three."), undefined);
		// Reject losing the first checkpoint, or replacing it with a stale page, when no stream existed yet.
		expect(streams.get(100)?.content).toBe("One. Two. Three.");
	});

	test("a settled page releases its old stream and only notifies that Variant", () => {
		const streams = createVariantStreams();
		streams.observe(append(1, "One."), undefined);
		let ownNotifications = 0;
		let otherNotifications = 0;
		streams.subscribe(100, () => ownNotifications++);
		streams.subscribe(101, () => otherNotifications++);
		streams.checkpoint([{ id: 100, position: 1, content: "Saved", empty: false, hasReasoning: false }]);
		// Reject retaining the full stream once a settled page has replaced it.
		expect(streams.get(100)).toBeUndefined();
		// Reject leaving mounted readers on the removed snapshot or broadcasting cleanup to unrelated Messages.
		expect([ownNotifications, otherNotifications]).toEqual([1, 0]);
	});

	test("retention drops ended Generations without dropping active off-window text", () => {
		const streams = createVariantStreams();
		streams.observe(append(1, "Finished"), undefined);
		streams.observe({ ...append(1, "Active"), generationId: 56, variantId: 101 }, undefined);
		streams.retain(new Set([56]));
		// Reject keeping an ended Generation's full text.
		expect(streams.get(100)).toBeUndefined();
		// Reject treating absence from the visible window as the end of an active Generation.
		expect(streams.get(101)?.content).toBe("Active");
	});

	test("an ended Generation keeps its text until a page settles its Variant", () => {
		const streams = createVariantStreams();
		const started = checkpoint(1, "One.");
		streams.checkpoint([started]);
		streams.observe(append(2, " Two."), started);
		streams.retain(new Set());
		// Reject falling back to the page's older checkpoint between the stream's end and the settled page.
		expect(streamedVariant(started, streams.get(100)).content).toBe("One. Two.");
		streams.checkpoint([{ id: 100, position: 1, content: "One. Two.", empty: false, hasReasoning: false }]);
		expect(streams.get(100)).toBeUndefined();
	});

	test("the last unsubscribe stops notifications and a new subscriber can use the same Variant", () => {
		const streams = createVariantStreams();
		let notifications = 0;
		const unsubscribe = streams.subscribe(100, () => notifications++);
		unsubscribe();
		streams.observe(append(1, "One."), undefined);
		// Reject retaining a callback after its Message unmounts.
		expect(notifications).toBe(0);
		streams.subscribe(100, () => notifications++);
		unsubscribe();
		streams.observe(append(2, " Two."), undefined);
		// Reject an old unsubscribe removing the replacement listener set.
		expect(notifications).toBe(1);
	});
});

describe("the Swipes browser stream reader", () => {
	const otherSwipe = (): StoryVariant => ({ ...checkpoint(0, ""), id: 101, generationId: 56 });
	const otherDelta = (eventId: number, text: string): VariantObservation => ({ ...append(eventId, text), variantId: 101, generationId: 56 });

	test("a non-selected Swipe shows its streamed text and stops showing the empty placeholder", () => {
		const streams = createVariantStreams();
		const variants = [checkpoint(0, ""), otherSwipe()];
		const reader = createVariantStreamReader(streams, variants);
		streams.observe(otherDelta(1, "Other reply."), variants[1]);
		// Reject overlaying only the selected Swipe while a sibling's Content stays at its empty checkpoint.
		expect(reader.getSnapshot()[1]).toMatchObject({ content: "Other reply.", empty: false, lastEventId: 1 });
	});

	test("opening subscribes to other Swipes, and closing detaches them without broadcasting other Messages", () => {
		const streams = createVariantStreams();
		const reader = createVariantStreamReader(streams, [checkpoint(0, ""), otherSwipe()]);
		let notifications = 0;
		const close = reader.subscribe(() => notifications++);
		streams.observe(otherDelta(1, "Other reply."), undefined);
		// Reject listening only to the selected Swipe, which never hears the sibling's delta.
		expect(notifications).toBe(1);
		const snapshot = reader.getSnapshot();
		// Reject allocating a new snapshot on every read, which causes an external-store render loop.
		expect(reader.getSnapshot()).toBe(snapshot);
		streams.observe({ ...append(1, "Another Message"), variantId: 102, generationId: 57 }, undefined);
		// Reject subscribing the browser to the whole workspace's traffic.
		expect(notifications).toBe(1);
		close();
		streams.observe(otherDelta(2, " More."), undefined);
		// Reject keeping browser-only subscriptions after the browser closes.
		expect(notifications).toBe(1);
	});
});

function reader() {
	const streams = createVariantStreams();
	let messages: StoryMessage[] = [];
	const placed = (messageId: number, variantId: number) =>
		messages.find((entry) => entry.id === messageId)?.swipes.find((variant) => variant.id === variantId);

	return {
		receive(received: ChatHistoryPage) { messages = received.messages.map(toStoryMessage); },
		observe(...observations: VariantObservation[]) {
			for (const observation of observations) streams.observe(observation, placed(observation.messageId, observation.variantId));
		},
		shown(variantId: number) {
			const variant = messages.flatMap((entry) => entry.swipes).find((entry) => entry.id === variantId);
			return variant && streamedVariant(variant, streams.get(variantId));
		},
	};
}

const target = { messageId: 10, variantId: 100, generationId: 55 };
const delta = (eventId: number, text: string, stream: "content" | "reasoning" = "content", at = target): VariantObservation =>
	({ ...at, eventId, mode: "append", stream, text });
const replace = (eventId: number, content: string, reasoning = "", at = target): VariantObservation =>
	({ ...at, eventId, mode: "replace", content, reasoning });

describe("streaming Provisional Variant content", () => {
	const provisional = { id: 100, position: 1, content: "", empty: true, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: true,
		liveGeneration: { generationId: 55, eventId: 0, content: "", reasoning: "" } };
	const stateWithProvisional = () => {
		const story = reader();
		story.receive(page({ revision: 4, messages: [message({ id: 10, variants: [provisional] })] }));
		return story;
	};

	for (const observedLive of [false, true]) test(`terminal history rejects later replay after live history was ${observedLive ? "observed" : "not observed"}`, () => {
		const story = observedLive ? stateWithProvisional() : reader();
		const content = "The tide turns against the pier.\n\nThen the";
		story.receive(page({ revision: 5, messages: [message({ id: 10, variants: [historyVariant({ content, hasReasoning: true })] })] }));
		for (const [index, text] of ["The tide turns against the pier.\n\n", "Then the"].entries()) {
			story.observe(delta(index + 1, text));
			expect(story.shown(100)?.content).toBe(content);
		}
		story.observe(replace(3, "Stale checkpoint", "Stale thought"));
		expect(story.shown(100)).toMatchObject({ content, reasoning: "", hasReasoning: true });
	});

	test("Content deltas append to the Provisional Variant and update the empty placeholder", () => {
		const story = stateWithProvisional();
		story.observe(delta(1, "Once upon "), delta(2, "a time"));
		expect(story.shown(100)).toMatchObject({ content: "Once upon a time", empty: false });
	});

	test("an authoritative Content replace overwrites the accumulated text", () => {
		const story = stateWithProvisional();
		story.observe(delta(1, "Stale tail"), replace(2, "Authoritative"));
		expect(story.shown(100)?.content).toBe("Authoritative");
	});

	test("Reasoning Content streams separately, and authoritative history hands it to the Variant text read", () => {
		const story = stateWithProvisional();
		story.observe(delta(1, "First thought. ", "reasoning"));
		expect(story.shown(100)).toMatchObject({ content: "", reasoning: "First thought. ", hasReasoning: true });
		story.observe(replace(2, "Finished.", "Authoritative thought."));
		expect(story.shown(100)?.reasoning).toBe("Authoritative thought.");

		story.receive(page({ revision: 5, messages: [message({ id: 10, variants: [
			historyVariant({ content: "Finished.", hasReasoning: true }),
		] })] }));
		// A stream that missed its end must not stand in for the persisted text.
		expect(story.shown(100)).toMatchObject({ content: "Finished.", reasoning: "", hasReasoning: true });
	});

	const unplaced = { messageId: 11, variantId: 110, generationId: 55 };
	const placing = (live: { eventId: number; content: string } | null, content = "") => {
		const variant: ChatHistoryPage["messages"][number]["variants"][number] = historyVariant({ id: 110, content, empty: content === "" });
		if (live) variant.liveGeneration = { generationId: 55, eventId: live.eventId, content: live.content, reasoning: "" };
		return page({ messages: [message({ id: 11, variants: [variant] })] });
	};

	test("stream events that land before the page placing their Variant show once it arrives", () => {
		const early = () => {
			const story = reader();
			story.observe(delta(1, "The tide.", "content", unplaced), delta(2, " The lights.", "content", unplaced), delta(3, " Then the", "content", unplaced));
			return story;
		};
		const live = early();
		live.receive(placing({ eventId: 0, content: "" }));
		expect(live.shown(110)?.content).toBe("The tide. The lights. Then the");

		const checkpointed = early();
		checkpointed.receive(placing({ eventId: 2, content: "The tide. The lights." }));
		expect(checkpointed.shown(110)?.content).toBe("The tide. The lights. Then the");

		const finished = early();
		finished.receive(placing(null, "The tide. The lights. Then the end."));
		expect(finished.shown(110)?.content).toBe("The tide. The lights. Then the end.");
	});

	test("off-window observations survive until placement, and a snapshot supersedes earlier ones", () => {
		const detached = () => {
			const story = reader();
			story.receive(page({ messages: [] }));
			story.observe(delta(1, "One.", "content", unplaced), delta(2, " Two.", "content", unplaced), delta(3, " Three.", "content", unplaced));
			return story;
		};
		const latest = placing({ eventId: 1, content: "One." });
		const returned = detached();
		returned.receive(latest);
		expect(returned.shown(110)?.content).toBe("One. Two. Three.");

		const snapshot = detached();
		snapshot.observe(replace(4, "One. Two. Three. Four.", "", unplaced));
		snapshot.receive(latest);
		expect(snapshot.shown(110)?.content).toBe("One. Two. Three. Four.");

		const staleSnapshot = detached();
		staleSnapshot.observe(replace(1, "One.", "", unplaced));
		staleSnapshot.receive(latest);
		expect(staleSnapshot.shown(110)?.content).toBe("One. Two. Three.");
	});

	test("history checkpoint and replay resume share one ordered projection", () => {
		const story = reader();
		story.receive(page({ messages: [message({ id: 10, variants: [{
			id: 100, position: 1, content: "Saved", empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: true,
			liveGeneration: { generationId: 55, eventId: 1, content: "Saved", reasoning: "" },
		}] })] }));
		story.observe(delta(1, "Saved"));
		expect(story.shown(100)?.content).toBe("Saved");
		story.observe(delta(2, " next"));
		expect(story.shown(100)?.content).toBe("Saved next");
	});
});
