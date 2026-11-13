import type { Painting } from "../../shared/contract/painting";

type Provisional = { painting: Exclude<Painting, { kind: "illustration" }>; controller: AbortController };
export const createProvisionalPaintings = () => {
	const byVariant = new Map<number, Map<string, Provisional>>();
	return {
		forVariant: (variantId: number) => byVariant.get(variantId)?.values() ?? [],
		get: (variantId: number, id: string) => byVariant.get(variantId)?.get(id),
		set(variantId: number, id: string, entry: Provisional) {
			const entries = byVariant.get(variantId) ?? new Map<string, Provisional>();
			entries.set(id, entry);
			byVariant.set(variantId, entries);
		},
		remove(variantId: number, id: string) {
			const entries = byVariant.get(variantId);
			entries?.delete(id);
			if (entries?.size === 0) byVariant.delete(variantId);
		},
		dispose() {
			for (const paintings of byVariant.values()) for (const { controller } of paintings.values()) controller.abort();
			byVariant.clear();
		},
	};
};
