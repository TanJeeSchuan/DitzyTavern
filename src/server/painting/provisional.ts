import type { Painting } from "../../shared/contract/painting";

type Provisional = { painting: Exclude<Painting, { kind: "illustration" }>; controller: AbortController };
export const createProvisionalPaintings = () => {
	const byVariant = new Map<number, Map<string, Provisional>>();
	return {
		byVariant,
		dispose() {
			for (const paintings of byVariant.values()) for (const { controller } of paintings.values()) controller.abort();
			byVariant.clear();
		},
	};
};
