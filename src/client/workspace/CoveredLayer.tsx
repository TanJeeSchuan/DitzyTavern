import type { ReactNode } from "react";
import { useLayerFocus } from "../lib/use-layer-focus";

export function CoveredLayer({ inert, children }: { inert: boolean; children: ReactNode }) {
	const onFocus = useLayerFocus(inert);
	return <div className="contents" inert={inert} onFocus={onFocus}>{children}</div>;
}
