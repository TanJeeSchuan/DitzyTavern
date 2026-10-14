import { Value } from "@sinclair/typebox/value";
import { useCallback, useState } from "react";
import { boxWindowLayouts, type BoxId, type BoxWindowLayout, type BoxWindowLayouts } from "../../shared/contract/box";

const storageKey = (conversationId: number) => `ditzytavern.box-windows.${conversationId}`;
const DEFAULT_LAYOUT: BoxWindowLayout = { open: false, minimized: false };

const readLayouts = (conversationId: number | null): BoxWindowLayouts => {
	if (conversationId === null) return {};
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(conversationId)) ?? "{}");
		// @approved
		// SAFETY: this module writes every stored value from the same
		// decoded shape; a tampered or stale value falls back to no layout.
		return Value.Check(boxWindowLayouts, parsed) ? parsed : {};
	} catch {
		return {};
	}
};

export interface BoxWindowsController {
	readonly layouts: BoxWindowLayouts;
	open(box: BoxId): void;
	minimize(box: BoxId): void;
	close(box: BoxId): void;
	move(box: BoxId, x: number, y: number): void;
}

// @approved
//  Window layouts are client-side and per Chat: local storage restores them
//  on reload, and switching Chat reads the new Chat's layouts rather than
//  reusing the previous one's.
export function useBoxWindows(conversationId: number | null): BoxWindowsController {
	const [state, setState] = useState(() => ({ conversationId, layouts: readLayouts(conversationId) }));
	if (state.conversationId !== conversationId) setState({ conversationId, layouts: readLayouts(conversationId) });

	const update = useCallback((box: BoxId, patch: Partial<BoxWindowLayout>) => {
		if (conversationId === null) return;
		const layout: BoxWindowLayout = { ...DEFAULT_LAYOUT, ...state.layouts[box], ...patch };
		const layouts: BoxWindowLayouts = { ...state.layouts, [box]: layout };
		window.localStorage.setItem(storageKey(conversationId), JSON.stringify(layouts));
		setState({ conversationId, layouts });
	}, [conversationId, state]);

	return {
		layouts: state.layouts,
		open: (box) => update(box, { open: true, minimized: false }),
		minimize: (box) => update(box, { minimized: true, open: true }),
		close: (box) => update(box, { open: false, minimized: false }),
		move: (box, x, y) => update(box, { x, y }),
	};
}
