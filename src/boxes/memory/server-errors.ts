import type { ConversationMemories, ConversationMemoryAllowance, MemorySettingsPayload } from "./contract";

/** @approved The current value a Memory route's conflict envelope carries. */
type MemoryConflict =
	| { readonly memories: ConversationMemories }
	| { readonly expectedRevision: number; readonly actualRevision: number; readonly currentSettings: ConversationMemoryAllowance | MemorySettingsPayload };

/** @approved A Memory command the writer must change; the route answers 422 with its message as the reason. */
export class InvalidMemoryCommandError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };
}

/** @approved A Memory write against a value that changed since it was read; the route answers 409 with `details`. */
class StaleMemoryError extends Error {
	readonly outcome = "conflict" as const;

	constructor(readonly details: MemoryConflict) {
		super("The Memory value changed since it was read.");
	}
}

/** @approved A stored-value guard: the write lands only on `expectedRevision`. */
export const memoryGuard = (expectedRevision: number, details: (actualRevision: number) => MemoryConflict) => (current: { readonly revision: number }) => {
	if (current.revision !== expectedRevision) throw new StaleMemoryError(details(current.revision));
};
