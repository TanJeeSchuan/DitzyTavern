import { useState } from "react";
import type { BoxSetups, SetupBoxId } from "../../shared/contract/box";
import type { BoxDataWrite } from "../../shared/contract/box-actions";
import type { ConversationAction, ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useSaveGuard } from "../SaveGuard";

const same = (left: BoxSetups[SetupBoxId], right: BoxSetups[SetupBoxId]) => JSON.stringify(left) === JSON.stringify(right);

// @approved
//  One Box setup form's draft against its saved setup. The expected revision
// follows the Chat while the saved setup is unchanged elsewhere; a conflict
// keeps the draft and loads the current saved setup beside it. The window's
// SaveGuard saves or discards the draft, and `extra` is further unsaved work
// it saves instead and discards along with the draft.
export function useBoxSetupDraft<Id extends SetupBoxId>(box: Id, { conversation, disabled, onConversationChange, conflict, valid = () => true, onSaved, extra }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	/** @approved The notice a conflicting save shows. */
	conflict: string;
	valid?: (setup: BoxSetups[Id]) => boolean;
	onSaved?: () => void;
	extra?: { save(): Promise<boolean>; discard(): void } | undefined;
}) {
	const current = conversation.boxSetups[box];
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
	const save = async (setup: BoxSetups[Id] = draft, writes?: BoxDataWrite[]): Promise<boolean> => {
		if (locked || !valid(setup)) return false;
		// @approved
		// SAFETY: `setup` is this Box's setup, which its set-box-setup action takes.
		const action = { type: "set-box-setup", box, setup, writes } as ConversationAction;
		return run(() => command(action, conflict, {
			onApplied: (next) => { setDraft(next.boxSetups[box]); setSaved(next.boxSetups[box]); onSaved?.(); },
			onConflict: (next) => { setSaved(next.boxSetups[box]); setRevision(next.revision); },
		}));
	};
	const discard = () => { setDraft(current); setSaved(current); setRevision(conversation.revision); setNotice(null); };
	useSaveGuard({ dirty: dirty || extra !== undefined, saving: pending, save: () => extra?.save() ?? save(), discard: () => { extra?.discard(); discard(); } });
	return { draft, setDraft, saved, dirty, pending, locked, notice, setNotice, run, command, save, discard };
}
