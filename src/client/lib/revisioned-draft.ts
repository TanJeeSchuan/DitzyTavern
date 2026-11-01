import { useRef, useState } from "react";
import { useVisitSignal } from "./visit";

/** @approved An authoritative value and the revision it was read at. */
export interface Revisioned<T> {
	value: T;
	revision: number;
}

// @approved
//  One editor's draft against the authoritative copy it started from. `base`
// is that copy: a save sends its revision, never one read live. A save claims
// the `submitted` value by reference, so only that save settles it; `edited`
// records typing while it is in flight, which the settled copy never replaces,
// and `seen` the newest authoritative copy that arrived meanwhile.
export type DraftSession<T> =
	| { status: "clean"; base: Revisioned<T> }
	| { status: "dirty"; base: Revisioned<T>; mine: T }
	| { status: "saving"; base: Revisioned<T>; mine: T; submitted: T; edited: boolean; seen: Revisioned<T> | null }
	| { status: "conflict"; mine: T; theirs: Revisioned<T> };

export type DraftEvent<T> =
	| { type: "observed"; server: Revisioned<T> }
	| { type: "edited"; mine: T }
	| { type: "save-started"; submitted: T }
	| { type: "saved"; submitted: T; saved: Revisioned<T> }
	| { type: "conflicted"; submitted: T; theirs: Revisioned<T> }
	| { type: "failed"; submitted: T }
	| { type: "kept-mine" }
	| { type: "discarded" };

/** @approved What a save reports: the copy it wrote, the copy it lost to, or neither. */
export type DraftSaveResult<T> =
	| { outcome: "saved"; saved: Revisioned<T> }
	| { outcome: "conflict"; theirs: Revisioned<T> }
	| { outcome: "failed" };

type Equals<T> = (left: T, right: T) => boolean;

const knownRevision = <T>(session: DraftSession<T>) =>
	session.status === "conflict" ? session.theirs.revision : session.status === "saving" ? (session.seen ?? session.base).revision : session.base.revision;
const newer = <T>(copy: Revisioned<T> | null, than: Revisioned<T>) => copy !== null && copy.revision > than.revision ? copy : than;
const against = <T>(base: Revisioned<T>, mine: T, equals: Equals<T>): DraftSession<T> =>
	equals(mine, base.value) ? { status: "clean", base } : { status: "dirty", base, mine };

// @approved
//  Whether `server` moves the session. A dirty draft follows a newer revision
// only while the value it edits is unchanged there; otherwise its save conflicts.
const observes = <T>(session: DraftSession<T> | null, server: Revisioned<T>, equals: Equals<T>) => {
	if (session === null) return true;
	if (server.revision <= knownRevision(session)) return false;
	return session.status !== "dirty" || equals(server.value, session.base.value);
};
const lostTo = <T>(mine: T, theirs: Revisioned<T>, equals: Equals<T>): DraftSession<T> =>
	equals(mine, theirs.value) ? { status: "clean", base: theirs } : { status: "conflict", mine, theirs };

export function reduceDraft<T>(session: DraftSession<T> | null, event: DraftEvent<T>, equals: Equals<T>): DraftSession<T> | null {
	if (session === null) return event.type === "observed" ? { status: "clean", base: event.server } : null;
	switch (event.type) {
		case "observed":
			if (!observes(session, event.server, equals)) return session;
			if (session.status === "saving") return { ...session, seen: event.server };
			return session.status === "conflict" ? { ...session, theirs: event.server } : { ...session, base: event.server };
		case "edited":
			if (session.status === "clean" || session.status === "dirty") return against(session.base, event.mine, equals);
			return session.status === "saving" ? { ...session, mine: event.mine, edited: true } : { ...session, mine: event.mine };
		case "save-started":
			if (session.status === "clean") return { ...session, status: "saving", mine: session.base.value, submitted: event.submitted, edited: false, seen: null };
			return session.status === "dirty" ? { ...session, status: "saving", submitted: event.submitted, edited: false, seen: null } : session;
		case "saved": {
			if (session.status !== "saving" || session.submitted !== event.submitted) return session;
			// @approved
			//  A copy newer than the save that changed its value replaced it:
			// the draft keeps what it submitted against that copy.
			const authority = newer(session.seen, event.saved);
			if (!equals(authority.value, event.saved.value)) return lostTo(session.mine, authority, equals);
			return session.edited ? against(authority, session.mine, equals) : { status: "clean", base: authority };
		}
		case "conflicted": {
			if (session.status !== "saving" || session.submitted !== event.submitted) return session;
			// @approved
			//  Revisions are shared with other values: a copy that still holds
			// what the draft started from only moved the revision, so the draft
			// stays unsaved against it instead of conflicting.
			const theirs = newer(session.seen, event.theirs);
			return equals(theirs.value, session.base.value) ? against(theirs, session.mine, equals) : lostTo(session.mine, theirs, equals);
		}
		case "failed": {
			if (session.status !== "saving" || session.submitted !== event.submitted) return session;
			const back = against(session.base, session.mine, equals);
			return session.seen === null ? back : reduceDraft(back, { type: "observed", server: session.seen }, equals);
		}
		case "kept-mine":
			return session.status === "conflict" ? against(session.theirs, session.mine, equals) : session;
		case "discarded":
			if (session.status === "conflict") return { status: "clean", base: session.theirs };
			return session.status === "dirty" ? { status: "clean", base: session.base } : session;
	}
}

/**
 * @approved
 * The revisioned draft of one editor visit to the entity `key` names. `server` is the authoritative copy, null
 * while it loads; `save` sends `submitted` at `revision` and reports the outcome. Another `key` starts a new draft,
 * and a save the old one started settles nothing.
 */
export function useRevisionedDraft<T>(server: Revisioned<T> | null, { key = null, equals, save }: {
	key?: string | number | null;
	equals: Equals<T>;
	save: (submitted: T, revision: number) => Promise<DraftSaveResult<T>>;
}) {
	const signal = useVisitSignal(key);
	const [stored, setStored] = useState<{ key: string | number | null; session: DraftSession<T> | null }>({ key, session: null });
	let session = stored.key === key ? stored.session : null;
	if (server !== null && observes(session, server, equals)) session = reduceDraft(session, { type: "observed", server }, equals);
	if (stored.key !== key || stored.session !== session) setStored({ key, session });
	const latest = useRef(session);
	latest.current = session;
	const apply = (event: DraftEvent<T>) => {
		const next = reduceDraft(latest.current, event, equals);
		if (next !== latest.current && !signal.aborted) { latest.current = next; setStored({ key, session: next }); }
		return next;
	};
	/** @approved Saves the draft, or `value` in its place; the draft itself is kept if that save fails. */
	const submit = async (value?: T, retry = true): Promise<boolean> => {
		const started = latest.current;
		if (started === null || (started.status !== "dirty" && (started.status !== "clean" || value === undefined))) return false;
		const submitted = value ?? (started.status === "dirty" ? started.mine : started.base.value);
		apply({ type: "save-started", submitted });
		const result = await save(submitted, started.base.revision).catch((): DraftSaveResult<T> => ({ outcome: "failed" }));
		const edited = latest.current?.status === "saving" && latest.current.edited;
		const settled = apply(result.outcome === "saved" ? { type: "saved", submitted, saved: result.saved }
			: result.outcome === "conflict" ? { type: "conflicted", submitted, theirs: result.theirs } : { type: "failed", submitted });
		// @approved
		//  A conflict that only moved the shared revision leaves the untouched
		// draft against the copy it lost to; it is sent once more against that.
		const moved = result.outcome === "conflict" && settled !== null && settled.status !== "conflict" && settled.status !== "saving" && settled.base === result.theirs;
		if (retry && moved && !edited) return submit(value, false);
		return result.outcome === "saved" && !edited && settled?.status === "clean";
	};
	return {
		session,
		value: session === null ? null : session.status === "clean" ? session.base.value : session.mine,
		/** @approved Unsaved edits that no in-flight save carries. */
		dirty: session !== null && (session.status === "dirty" || session.status === "conflict" || (session.status === "saving" && session.edited)),
		saving: session?.status === "saving",
		/** @approved The authoritative copy the draft is against: the one it lost to while in conflict. */
		saved: session === null ? null : session.status === "conflict" ? session.theirs : session.base,
		conflict: session?.status === "conflict",
		edit: (mine: T) => { apply({ type: "edited", mine }); },
		/** @approved Edits the latest draft, so changes made before the next render compose. */
		update: (change: (current: T) => T) => {
			const current = latest.current;
			if (current !== null) apply({ type: "edited", mine: change(current.status === "clean" ? current.base.value : current.mine) });
		},
		save: (value?: T) => submit(value),
		/** @approved Keeps the edits and takes the copy they lost to as their new base. */
		keepMine: () => { apply({ type: "kept-mine" }); },
		discard: () => { apply({ type: "discarded" }); },
	};
}
