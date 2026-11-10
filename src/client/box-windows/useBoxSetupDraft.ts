import type { Static, TSchema } from "@sinclair/typebox";
import { useState } from "react";
import type { BoxId } from "../../shared/contract/box";
import { boxSetupOf, type BoxValue } from "../../shared/contract/box-value";
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
// saves or discards the draft. `schema` is the Box's own setup schema, which
// types and checks the setup it reads.
export function useBoxSetupDraft<Schema extends SetupSchema>(box: BoxId, schema: Schema, { conversation, disabled, onConversationChange, conflict, valid = () => true, onSaved }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	/** @approved The notice a conflicting save shows. */
	conflict: string;
	valid?: (setup: Static<Schema>) => boolean;
	onSaved?: () => void;
}) {
	const [notice, setNotice] = useState<string | null>(null);
	/** @approved Runs one command at the Chat's revision, or exactly at the draft's base `revision` for its save. */
	const command = (action: ConversationAction, conflictNotice: string, handlers: { onApplied?: (next: ConversationSummary) => void; onConflict?: (next: ConversationSummary) => void } = {}, revision?: number) =>
		runConversationCommand({ conversationId: conversation.id, revision: () => revision ?? conversation.revision, exact: revision !== undefined, onConversationChange, setNotice }, action, {
			notices: { conflict: conflictNotice, notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
			onApplied: handlers.onApplied,
			onConflict: handlers.onConflict,
		});
	const setup = (next: ConversationSummary) => ({ value: boxSetupOf(next, box, schema), revision: next.revision });
	const draft = useRevisionedDraft<Static<Schema>>(setup(conversation), {
		equals: same,
		save: async (submitted, revision) => {
			let result: DraftSaveResult<Static<Schema>> = { outcome: "failed" };
			await command({ type: "set-box-setup", box, setup: submitted }, conflict, {
				onApplied: (next) => { result = { outcome: "saved", saved: setup(next) }; onSaved?.(); },
				onConflict: (next) => { result = { outcome: "conflict", theirs: setup(next) }; },
			}, revision);
			return result;
		},
	});
	const value = draft.value ?? boxSetupOf(conversation, box, schema);
	const locked = draft.saving || disabled;
	/** @approved Saves `next`, the draft unless the form saves something else. */
	const save = async (next?: Static<Schema>): Promise<boolean> => {
		if (locked || !valid(next ?? value)) return false;
		setNotice(null);
		draft.keepMine();
		return draft.save(next);
	};
	const discard = () => { draft.discard(); setNotice(null); };
	useSaveGuard({ dirty: draft.dirty, saving: draft.saving, save: () => save(), discard });
	return { draft: value, setDraft: draft.edit, updateDraft: draft.update, saved: draft.saved?.value ?? value, conflict: draft.conflict, dirty: draft.dirty, pending: draft.saving, locked, notice, save, discard };
}
