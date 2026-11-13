import { describe, expect, test } from "bun:test";
import type { StoryVariant } from "../story";
import { createVariantStreams, streamedVariant, type VariantObservation } from "./variant-streams";

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
