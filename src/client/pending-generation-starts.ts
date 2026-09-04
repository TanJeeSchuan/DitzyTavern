export type PendingGenerationStarts = ReadonlyMap<number, number | null>;

export type PendingGenerationStartsAction =
	| { readonly type: "started"; readonly startId: number }
	| {
			readonly type: "accepted";
			readonly startId: number;
			readonly generationId: number;
	  }
	| { readonly type: "settled"; readonly startId: number }
	| {
			readonly type: "sessions-observed";
			readonly generationIds: ReadonlySet<number>;
	  }
	| { readonly type: "conversation-switched" };

export const createPendingGenerationStarts = (): PendingGenerationStarts => new Map();

export function reducePendingGenerationStarts(
	state: PendingGenerationStarts,
	action: PendingGenerationStartsAction,
): PendingGenerationStarts {
	switch (action.type) {
		case "started": {
			const next = new Map(state);
			next.set(action.startId, null);
			return next;
		}
		case "accepted": {
			if (!state.has(action.startId)) return state;
			const next = new Map(state);
			next.set(action.startId, action.generationId);
			return next;
		}
		case "settled": {
			if (!state.has(action.startId)) return state;
			const next = new Map(state);
			next.delete(action.startId);
			return next;
		}
		case "sessions-observed": {
			const settled = [...state].filter(
				([, generationId]) =>
					generationId !== null && action.generationIds.has(generationId),
			);
			if (settled.length === 0) return state;
			const next = new Map(state);
			for (const [startId] of settled) next.delete(startId);
			return next;
		}
		case "conversation-switched":
			return state.size === 0 ? state : createPendingGenerationStarts();
	}
}
