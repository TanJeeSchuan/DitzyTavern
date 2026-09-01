// ==[HUMAN APPROVED]== Shared seam for typed server command outcomes: every transport helper maps
// the same `payload.outcome === …` chain onto a client outcome union, and the
// panels repeat the same notice wordings. Both live here so the wording can
// never drift between sites.

// ==[HUMAN APPROVED]== Verbatim shared notices (byte-identical at every adopting site):
export const CONVERSATION_UNREACHABLE_NOTICE =
	"The Conversation could not be reached.";
export const LIBRARY_UNREACHABLE_NOTICE = "The Library could not be reached.";
export const CONVERSATION_CONFLICT_RELOAD_NOTICE =
	"The Conversation changed elsewhere; the current Cast was loaded.";

type OutcomeHandlers<P extends { outcome: string }, O> = {
	[K in P["outcome"] & string]?: (payload: Extract<P, { outcome: K }>) => O;
};

/**
 * ==[HUMAN APPROVED]== Maps one command-error payload onto the client outcome union. Handlers are
 * keyed by the server outcome name and only need to cover the outcomes that
 * carry extra fields: `not-found` maps to its client outcome by default, and
 * any payload without a handler falls back to the network outcome. The
 * client status always equals the server outcome name.
 */
export function commandOutcome<P extends { outcome: string }, O>(
	payload: P,
	handlers: OutcomeHandlers<P, O>,
): O | { status: "not-found" } | { status: "network" } {
	// ==[HUMAN APPROVED]== SAFETY: OutcomeHandlers is keyed by exactly the payload's outcome union,
	// so the payload's own outcome value is a valid lookup key.
	const outcome = payload.outcome as P["outcome"] & string;
	const handler = handlers[outcome];
	if (handler === undefined) {
		return payload.outcome === "not-found" ? { status: "not-found" } : { status: "network" };
	}
	// ==[HUMAN APPROVED]== SAFETY: the handler was looked up under the payload's own outcome key,
	// so its Extract'ed parameter type is exactly this payload's shape.
	return (handler as (payload: P) => O)(payload);
}
