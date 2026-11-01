import { expect, test } from "bun:test";
import { reduceDraft, type DraftEvent, type DraftSession } from "./revisioned-draft";

const equals = (left: string, right: string) => left === right;
const run = (events: DraftEvent<string>[]) => events.reduce<DraftSession<string> | null>((session, event) => reduceDraft(session, event, equals), null);
const opened = (value: string, revision: number): DraftEvent<string> => ({ type: "observed", server: { value, revision } });

test("a conflict whose copy only moved the revision keeps the draft saveable against it", () => {
	const submitted = "mine";
	const session = run([opened("base", 1), { type: "edited", mine: submitted }, { type: "save-started", submitted }, { type: "conflicted", submitted, theirs: { value: "base", revision: 4 } }]);
	expect(session).toEqual({ status: "dirty", base: { value: "base", revision: 4 }, mine: "mine" });
});

test("a conflict with a changed copy keeps the draft and refuses to save until it is resolved", () => {
	const submitted = "mine";
	const lost = run([opened("base", 1), { type: "edited", mine: submitted }, { type: "save-started", submitted }, { type: "conflicted", submitted, theirs: { value: "theirs", revision: 4 } }]);
	expect(lost).toEqual({ status: "conflict", mine: "mine", theirs: { value: "theirs", revision: 4 } });
	expect(reduceDraft(lost, { type: "save-started", submitted }, equals)).toBe(lost);
	expect(reduceDraft(lost, { type: "kept-mine" }, equals)).toEqual({ status: "dirty", base: { value: "theirs", revision: 4 }, mine: "mine" });
});

test("a save overtaken by a newer changed copy keeps what it submitted against that copy", () => {
	const submitted = "mine";
	const session = run([
		opened("base", 1), { type: "edited", mine: submitted }, { type: "save-started", submitted },
		opened("theirs", 3), { type: "saved", submitted, saved: { value: "mine", revision: 2 } },
	]);
	expect(session).toEqual({ status: "conflict", mine: "mine", theirs: { value: "theirs", revision: 3 } });
});

test("only the save that claimed the submitted draft settles it", () => {
	const session = run([opened("base", 1), { type: "edited", mine: "mine" }, { type: "save-started", submitted: "mine" }]);
	expect(reduceDraft(session, { type: "saved", submitted: "other", saved: { value: "other", revision: 2 } }, equals)).toBe(session);
	expect(reduceDraft(session, { type: "discarded" }, equals)).toBe(session);
});
