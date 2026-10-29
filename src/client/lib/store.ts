export type Store<T> = { get: () => T; set: (next: T) => void; subscribe: (listener: () => void) => () => void };

// @approved
// A value held outside React state, so only components that subscribe through
// useSyncExternalStore re-render when it changes.
export const store = <T>(initial: T): Store<T> => {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		set: (next) => {
			if (Object.is(next, value)) return;
			value = next;
			for (const listener of listeners) listener();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
};
