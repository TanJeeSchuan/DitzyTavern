import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoryMessage } from "../story";

type StoryViewportOptions = {
	messages: readonly StoryMessage[];
	conversationId: number | null;
	isGenerating: boolean;
};

/**
 * ==[HUMAN APPROVED]== Owns the reading surface's scroll state. The story is bottom-pinned when a
 * Chat opens, stays anchored while older pages are prepended, and moves to a
 * switched Message when a Swipe changes.
 */
export function useStoryViewport({
	messages,
	conversationId,
	isGenerating,
}: StoryViewportOptions) {
	const storyScrollRef = useRef<HTMLDivElement>(null);
	const latestRef = useRef<HTMLDivElement>(null);
	const [isAtLatest, setIsAtLatest] = useState(true);
	const anchoredLastMessageIdRef = useRef<number | null>(null);
	const anchoredScrollHeightRef = useRef(0);
	const swipeScrollTargetRef = useRef<number | null>(null);

	useEffect(() => {
		const root = storyScrollRef.current;
		const latest = latestRef.current;
		if (!root || !latest) return;

		const observer = new IntersectionObserver(
			([entry]) => setIsAtLatest(entry.isIntersecting),
			{ root, threshold: 0.5 },
		);
		observer.observe(latest);
		return () => observer.disconnect();
	}, [messages.length, isGenerating]);

	useLayoutEffect(() => {
		const root = storyScrollRef.current;
		if (!root) return;
		if (messages.length === 0) {
			anchoredLastMessageIdRef.current = null;
			anchoredScrollHeightRef.current = root.scrollHeight;
			return;
		}

		const lastId = messages[messages.length - 1].id;
		const previousLastId = anchoredLastMessageIdRef.current;
		const previousHeight = anchoredScrollHeightRef.current;
		anchoredLastMessageIdRef.current = lastId;
		anchoredScrollHeightRef.current = root.scrollHeight;

		if (previousLastId === null || previousLastId !== lastId) {
			root.scrollTop = root.scrollHeight;
			return;
		}
		if (root.scrollHeight > previousHeight) {
			root.scrollTop += root.scrollHeight - previousHeight;
		}
	}, [messages, conversationId]);

	useLayoutEffect(() => {
		const target = swipeScrollTargetRef.current;
		swipeScrollTargetRef.current = null;
		if (target === null) return;
		storyScrollRef.current
			?.querySelector(`.story-message[data-message-id="${target}"]`)
			?.scrollIntoView({ block: "start" });
	});

	const queueSwipeScroll = (messageId: number) => {
		swipeScrollTargetRef.current = messageId;
	};

	return {
		storyScrollRef,
		latestRef,
		isAtLatest,
		queueSwipeScroll,
	};
}
