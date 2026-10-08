import { afterEach, describe, expect, test } from "bun:test";
import type { GenerationStreamResult, GenerationStreamSubscription } from "../conversation-stream";
import { createGenerationSessionRunner } from "../generation-session-runner";
import type { GenerationSessionTarget } from "../generation-sessions";
import type { StoryAction } from "../story";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { reduceStory, createStoryState } = await import("../story");

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// Thin wiring test: one pass of the runner
// against the real story reducer. Full rendering stays with the browser
// smoke checks; the wiring is the seam under test here.

const observe = (generationIds: readonly number[]) =>
	({
		type: "targets-observed",
		conversationId: 42,
		targets: generationIds.map((generationId): GenerationSessionTarget => ({
			generationId,
			messageId: 10,
			variantId: 100,
		})),
	}) as const;

describe("Generation session wiring", () => {
	test("the runner and the story reducer compose into visible streaming text", () => {
		const stream = oneShotStream();
		const storyActions: StoryAction[] = [];
		const runner = createGenerationSessionRunner({
			adapter: stream.adapter,
			applyStoryEffect: (effect) => {
				storyActions.push(effect);
			},
			refreshConversation: async () => {},
		});

		runner.dispatch(observe([7]));
		stream.requests[0]!.onEvent({ eventId: 1, event: { type: "content", text: "Once upon " } });
		stream.requests[0]!.onEvent({ eventId: 2, event: { type: "reasoning", text: "planning" } });
		stream.requests[0]!.onEvent({ eventId: 3, event: { type: "content", text: "a time" } });
		stream.settle(0, { outcome: "applied" });

		let story = createStoryState();
		story = reduceStory(story, { type: "chat-opened", conversationId: 42 });
		story = reduceStory(story, {
			type: "first-page",
			page: {
				conversationId: 42,
				name: "Lantern House",
				revision: 4,
				cast: [],
				page: { index: 1, pageSize: 2, totalMessages: 1, totalPages: 1, hasOlder: false, hasNewer: false },
				messages: [{
					id: 10,
					position: 1,
					timestamp: "2026-01-01T00:00:00.000Z",
					modelParticipantIdAtCreation: 20,
					continuable: true,
					swipe: { eligible: true, reason: null },
					author: { participantId: 20, capturedName: "Model", inCast: true },
					variants: [
						{ id: 100, position: 1, content: "", timestamp: "2026-01-01T00:00:00.000Z", selected: true },
					],
				}],
			},
		});
		for (const action of storyActions) {
			story = reduceStory(story, action);
		}

		expect(story.messages[0]?.swipes[0]?.content).toBe("Once upon a time");
		expect(story.messages[0]?.swipes[0]?.reasoning).toBe("planning");
	});
});

interface OneShotStream {
	adapter: import("../conversation-stream").GenerationStreamAdapter;
	requests: GenerationStreamSubscription[];
	settle: (index: number, result: GenerationStreamResult) => void;
}

function oneShotStream(): OneShotStream {
	const requests: GenerationStreamSubscription[] = [];
	const pending: { resolve: (result: GenerationStreamResult) => void }[] = [];
	return {
		requests,
		adapter: {
			subscribe: (request) => new Promise<GenerationStreamResult>((resolve) => {
				requests.push(request);
				pending.push({ resolve });
			}),
		},
		settle: (index, result) => pending[index]!.resolve(result),
	};
}
