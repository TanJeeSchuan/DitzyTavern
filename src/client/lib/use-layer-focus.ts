import { useEffect, useRef, type FocusEvent } from "react";

// @approved Inert layers return focus when uncovered; Message actions hide on blur, so their Message receives focus instead.
export function useLayerFocus(inert: boolean) {
	const lastFocus = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (inert || (document.activeElement !== null && document.activeElement !== document.body)) return;
		(lastFocus.current?.closest<HTMLElement>(".story-message") ?? lastFocus.current)?.focus({ preventScroll: true });
	}, [inert]);
	return (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.contains(event.target)) lastFocus.current = event.target; };
}
