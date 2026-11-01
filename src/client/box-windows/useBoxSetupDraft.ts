import type { Static, TSchema } from "@sinclair/typebox";
import { useRef, useState } from "react";
import type { BoxId } from "../../shared/contract/box";
import { boxSetupOf, type BoxValue } from "../../shared/contract/box-value";
import type { BoxDataWrite } from "../../shared/contract/box-actions";
import type { ConversationAction, ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useRevisionedDraft, type DraftSaveResult } from "../lib/revisioned-draft";
import { useSaveGuard } from "../SaveGuard";

const same = (left: BoxValue, right: BoxValue) => JSON.stringify(left) === JSON.stringify(right);
/** @approved A Box's own setup schema, whose values the host holds as Box values. */
type SetupSchema = TSchema & { static: BoxValue };

// @approved
//  One Box setup form's draft against its saved setup, as a revisioned draft:
// an untouched draft follows the Chat's setup, an edited one follows the
// revision only while the saved setup is unchanged elsewhere, and a conflict
// keeps the draft beside the current saved setup. Saving again from a conflict
// replaces that setup, as the conflict notice says. The window's SaveGuard
// saves or discards the draft, and `extra` is further unsaved work it saves
// instead and discards along with the draft. `schema` is the Box's own setup
// schema, which types and checks the setup it reads.
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
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const writes = useRef<BoxDataWrite[] | undefined>(undefined);
	/** @approved Runs one command at `revision`, the draft's base unless the command says otherwise. */
	const command = (action: ConversationAction, conflictNotice: string, handlers: { onApplied?: (next: ConversationSummary) => void; onConflict?: (next: ConversationSummary) => void } = {}, revision = conversation.revision) =>
		runConversationCommand({ conversationId: conversation.id, revision: () => revision, onConversationChange, setNotice }, action, {
			notices: { conflict: conflictNotice, notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
			onApplied: handlers.onApplied,
			onConflict: handlers.onConflict,
		});
	const setup = (next: ConversationSummary) => ({ value: boxSetupOf(next, box, schema), revision: next.revision });
	const draft = useRevisionedDraft<Static<Schema>>(setup(conversation), {
		equals: same,
		save: async (submitted, revision) => {
			let result: DraftSaveResult<Static<Schema>> = { outcome: "failed" };
			await command({ type: "set-box-setup", box, setup: submitted, writes: writes.current }, conflict, {
				onApplied: (next) => { result = { outcome: "saved", saved: setup(next) }; onSaved?.(); },
				onConflict: (next) => { result = { outcome: "conflict", theirs: setup(next) }; },
			}, revision);
			return result;
		},
	});
	const value = draft.value ?? boxSetupOf(conversation, box, schema);
	const locked = pending || draft.saving || disabled;

	/** @approved Marks the form pending around one task, clearing the notice first. */
	const run = async <Result>(task: () => Promise<Result>): Promise<Result> => {
		setPending(true);
		setNotice(null);
		try { return await task(); } finally { setPending(false); }
	};
	/** @approved Saves `next`, the draft unless the form saves something else, with the Box's own data `writes`. */
	const save = async (next?: Static<Schema>, boxWrites?: BoxDataWrite[]): Promise<boolean> => {
		if (locked || !valid(next ?? value)) return false;
		setNotice(null);
		draft.keepMine();
		writes.current = boxWrites;
		return draft.save(next);
	};
	const discard = () => { draft.discard(); setNotice(null); };
	useSaveGuard({ dirty: draft.dirty || extra !== undefined, saving: pending || draft.saving, save: () => extra?.save() ?? save(), discard: () => { extra?.discard(); discard(); } });
	return { draft: value, setDraft: draft.edit, updateDraft: draft.update, saved: draft.saved?.value ?? value, conflict: draft.conflict, dirty: draft.dirty, pending: pending || draft.saving, locked, notice, setNotice, run, command, save, discard };
}
