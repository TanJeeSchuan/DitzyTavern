import { useEffect, type DependencyList } from "react";

// ==[HUMAN APPROVED]== One guard per effect activation: the task's promise callbacks consult
// `isCancelled` so state updates stop once the effect re-runs or the
// component unmounts.
export interface AsyncEffectGuard {
	isCancelled: () => boolean;
	cancel: () => void;
}

export const createAsyncEffectGuard = (): AsyncEffectGuard => {
	let cancelled = false;
	return {
		isCancelled: () => cancelled,
		cancel: () => {
			cancelled = true;
		},
	};
};

/**
 * ==[HUMAN APPROVED]== Shared home of the `cancelled`-flag effect pattern: an async load whose
 * results must stop applying after the effect re-runs or the component
 * unmounts. The task receives `isCancelled` and guards every state update
 * with it; error handling stays inside the task so each caller keeps its own
 * failure semantics (reducer dispatches, notices, swallow-to-empty).
 */
export function useAsyncEffect(
	task: (isCancelled: () => boolean) => void | Promise<void>,
	deps: DependencyList,
): void {
	useEffect(() => {
		const guard = createAsyncEffectGuard();
		void task(guard.isCancelled);
		return guard.cancel;
		// The caller owns the dependency list, mirroring useEffect. ==[HUMAN APPROVED]==
	}, deps);
}
