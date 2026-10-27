import { useState } from "react";
import type { SwipeBrowsing } from "../workspace";

const SWIPE_BROWSING_KEY = "ditzytavern-swipe-browsing";

// @approved
//  How a Message's Swipes open from their counter or a long press, kept per device like the theme.
export function useSwipeBrowsing() {
	const [mode, setMode] = useState<SwipeBrowsing>(() => window.localStorage.getItem(SWIPE_BROWSING_KEY) === "modal" ? "modal" : "fan");
	const setPersistedMode = (next: SwipeBrowsing) => {
		window.localStorage.setItem(SWIPE_BROWSING_KEY, next);
		setMode(next);
	};
	return [mode, setPersistedMode] as const;
}
