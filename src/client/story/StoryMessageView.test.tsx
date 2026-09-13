import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoryMessage } from "../story";
import { StoryMessageView } from "./StoryMessageView";

const message = (reasoning: string): StoryMessage => ({
	id: 10,
	position: 1,
	timestamp: "2026-01-01T00:00:00.000Z",
	authorName: "Maren",
	authorParticipantId: 2,
	modelParticipantIdAtCreation: null,
	continuable: true,
	swipe: { eligible: true, reason: null },
	inCast: true,
	activeSwipe: 0,
	swipes: [{
		id: 100,
		position: 1,
		content: "The lamp turns.",
		empty: false,
		reasoning,
	}],
});

describe("Story Message Reasoning Content", () => {
	test("collapses Reasoning Content without hiding generated prose", () => {
		const markup = renderToStaticMarkup(
			<StoryMessageView
				message={message("Keep the answer grounded in the room.")}
				onMoveSwipe={() => {}}
				onEdit={() => {}}
			/>,
		);

		expect(markup).toContain('aria-label="Reasoning Content"');
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).not.toContain("Keep the answer grounded in the room.");
		expect(markup).toContain("The lamp turns.");
	});

	test("omits the Reasoning Content region when no reasoning was observed", () => {
		const markup = renderToStaticMarkup(
			<StoryMessageView
				message={message("")}
				onMoveSwipe={() => {}}
				onEdit={() => {}}
			/>,
		);

		expect(markup).not.toContain('aria-label="Reasoning Content"');
	});
});
