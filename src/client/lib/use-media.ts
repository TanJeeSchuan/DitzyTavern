import { useSyncExternalStore } from "react";

const NARROW = "(max-width: 78rem)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const subscribeTo = (query: string) => (onChange: () => void) => {
	const media = window.matchMedia(query);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
};
const subscribeNarrow = subscribeTo(NARROW);
const subscribeReducedMotion = subscribeTo(REDUCED_MOTION);

// @approved
// Below this width panels and Box windows become full-screen layers instead of sitting beside the Chat.
export const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches);
export const useReducedMotion = () => useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED_MOTION).matches);
