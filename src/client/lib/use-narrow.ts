import { useSyncExternalStore } from "react";

const NARROW = "(max-width: 78rem)";
const subscribe = (onChange: () => void) => {
	const media = window.matchMedia(NARROW);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
};

// @approved
// Below this width panels and Box windows become full-screen layers instead of sitting beside the Chat.
export const useNarrow = () => useSyncExternalStore(subscribe, () => window.matchMedia(NARROW).matches);
