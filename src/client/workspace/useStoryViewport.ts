import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StoryMessage } from "../story";

type StoryViewportOptions = {
	messages: readonly StoryMessage[];
	conversationId: number | null;
};

const FOLLOW_DISTANCE = 48;

const smooth = (): ScrollBehavior =>
	matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";

const nearBottom = (root: HTMLElement) =>
	root.scrollHeight - root.scrollTop - root.clientHeight < FOLLOW_DISTANCE;

/**
 * ==[HUMAN APPROVED]== Owns the reading surface's scroll state. The story is bottom-pinned when a
 * Chat opens, stays anchored while older pages are prepended, and moves to a
 * switched Message when a Swipe changes.
 */
export function useStoryViewport({ messages, conversationId }: StoryViewportOptions) {
	const storyScrollRef = useRef<HTMLDivElement>(null);
	const followingRef = useRef(true);
	const [isAtLatest, setIsAtLatest] = useState(true);
	const lastScrollTopRef = useRef(0);
	const anchoredRef = useRef<{ firstId: number; lastId: number; scrollHeight: number } | null>(null);
	const swipeScrollTargetRef = useRef<number | null>(null);

	const follow = (following: boolean) => {
		followingRef.current = following;
		setIsAtLatest(following);
	};

	// Scrolling up stops following new content; returning near the bottom resumes it.
	const onStoryScroll = () => {
		const root = storyScrollRef.current;
		if (!root) return;
		if (nearBottom(root)) follow(true);
		else if (root.scrollTop < lastScrollTopRef.current - 1) follow(false);
		lastScrollTopRef.current = root.scrollTop;
	};

	useEffect(() => {
		const root = storyScrollRef.current;
		const content = root?.firstElementChild;
		if (!root || !content) return;
		const observer = new ResizeObserver(() => {
			if (followingRef.current) root.scrollTo({ top: root.scrollHeight, behavior: smooth() });
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [conversationId]);

	useLayoutEffect(() => {
		const root = storyScrollRef.current;
		const first = messages[0];
		const last = messages.at(-1);
		if (!root) return;
		const previous = anchoredRef.current;
		anchoredRef.current = first && last ? { firstId: first.id, lastId: last.id, scrollHeight: root.scrollHeight } : null;
		if (!first || !last) return;

		if (previous === null || !messages.some((message) => message.id === previous.lastId)) {
			root.scrollTo({ top: root.scrollHeight, behavior: "instant" });
			follow(true);
		} else if (previous.lastId !== last.id) {
			follow(true);
			root.scrollTo({ top: root.scrollHeight, behavior: smooth() });
		} else if (previous.firstId !== first.id && root.scrollHeight > previous.scrollHeight) {
			root.scrollTo({ top: root.scrollTop + root.scrollHeight - previous.scrollHeight, behavior: "instant" });
		}
	}, [messages, conversationId]);

	useLayoutEffect(() => {
		const target = swipeScrollTargetRef.current;
		swipeScrollTargetRef.current = null;
		const root = storyScrollRef.current;
		if (target === null || !root) return;
		root.querySelector(`.story-message[data-message-id="${target}"]`)?.scrollIntoView({ block: "start" });
		follow(nearBottom(root));
	});

	const queueSwipeScroll = (messageId: number) => {
		swipeScrollTargetRef.current = messageId;
	};

	const followLatest = (messageId: number) => {
		const root = storyScrollRef.current;
		if (!root || messageId !== messages.at(-1)?.id) return;
		follow(true);
		root.scrollTo({ top: root.scrollHeight, behavior: smooth() });
	};

	return {
		storyScrollRef,
		onStoryScroll,
		isAtLatest,
		queueSwipeScroll,
		followLatest,
	};
}
