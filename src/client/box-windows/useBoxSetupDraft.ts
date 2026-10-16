import type { Static, TSchema } from "@sinclair/typebox";
import { useState } from "react";
import type { BoxId } from "../../shared/contract/box";
import { boxSetupOf, type BoxValue } from "../../shared/contract/box-value";
import type { BoxDataWrite } from "../../shared/contract/box-actions";
import type { ConversationAction, ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useSaveGuard } from "../SaveGuard";

const same = (left: BoxValue, right: BoxValue) => JSON.stringify(left) === JSON.stringify(right);
/** @approved A Box's own setup schema, whose values the host holds as Box values. */
type SetupSchema = TSchema & { static: BoxValue };

// @approved
//  One Box setup form's draft against its saved setup. The expected revision
// follows the Chat while the saved setup is unchanged elsewhere; a conflict
// keeps the draft and loads the current saved setup beside it. The window's
// SaveGuard saves or discards the draft, and `extra` is further unsaved work
// it saves instead and discards along with the draft. `schema` is the Box's
// own setup schema, which types and checks the setup it reads.
export function useBoxSetupDraft<Schema extends SetupSchema>(box: BoxId, schema: Schema, { conversation, disabled, onConversationChange, conflict, valid = () => true, onSaved, extra }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	/** @approved The notice a conflicting save shows. */
	conflict: string;
	valid?: (setup: Static<Schema>) => boolean;
	onSaved?: () => void;
	extra?: { save(): Promise<boolean>; discard(): void } | undefined;
}) {
	const current = boxSetupOf(conversation, box, schema);
	const [draft, setDraft] = useState(current);
	const [saved, setSaved] = useState(current);
	const [revision, setRevision] = useState(conversation.revision);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	if (conversation.revision > revision && same(current, saved)) setRevision(conversation.revision);
	const locked = pending || disabled;
	const dirty = !same(draft, saved);

	/** @approved Marks the form pending around one task, clearing the notice first. */
	const run = async <Result>(task: () => Promise<Result>): Promise<Result> => {
		setPending(true);
		setNotice(null);
		try { return await task(); } finally { setPending(false); }
	};
	/** @approved Runs one command at the form's expected revision, which applying it advances. */
	const command = (action: ConversationAction, conflictNotice: string, handlers: { onApplied?: (next: ConversationSummary) => void; onConflict?: (next: ConversationSummary) => void } = {}) =>
		runConversationCommand({ conversationId: conversation.id, revision: () => revision, onConversationChange, setNotice }, action, {
			notices: { conflict: conflictNotice, notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
			onApplied: (next) => { setRevision(next.revision); handlers.onApplied?.(next); },
			onConflict: handlers.onConflict,
		});
	/** @approved Saves `setup`, the draft unless the form saves something else, with the Box's own data `writes`. */
	const save = async (setup: Static<Schema> = draft, writes?: BoxDataWrite[]): Promise<boolean> => {
		if (locked || !valid(setup)) return false;
		return run(() => command({ type: "set-box-setup", box, setup, writes }, conflict, {
			onApplied: (next) => { setDraft(boxSetupOf(next, box, schema)); setSaved(boxSetupOf(next, box, schema)); onSaved?.(); },
			onConflict: (next) => { setSaved(boxSetupOf(next, box, schema)); setRevision(next.revision); },
		}));
	};
	const discard = () => { setDraft(current); setSaved(current); setRevision(conversation.revision); setNotice(null); };
	useSaveGuard({ dirty: dirty || extra !== undefined, saving: pending, save: () => extra?.save() ?? save(), discard: () => { extra?.discard(); discard(); } });
	return { draft, setDraft, saved, dirty, pending, locked, notice, setNotice, run, command, save, discard };
}
