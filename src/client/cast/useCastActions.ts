import { useState } from "react";
import {
	CONVERSATION_CONFLICT_RELOAD_NOTICE,
	CONVERSATION_UNREACHABLE_NOTICE,
	LIBRARY_UNREACHABLE_NOTICE,
} from "../lib/command-outcome";
import {
	addCharacterToCast,
	applyConversationCommand,
	loadConversation,
	saveParticipantAsCharacter,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import type { CharacterSnapshot } from "../character-library";
import { emptyAdHocDraft, openingsFromText, type AdHocDraft } from "./definition";

// ==[HUMAN APPROVED]== The minimal reference the drawer needs to offer navigation into the new
// Character Library entry. Internal identifiers are not displayed anywhere.
export interface SavedCharacterReference {
	id: number;
	name: string;
}

// ==[HUMAN APPROVED]== The character-library add command's extra outcome: the conflict names the
// changed Character instead of carrying a Conversation snapshot, so the
// runner must not adopt or word it and forwards it untouched.
type AddCharacterOperation = {
	kind: "character-changed";
	currentCharacterName?: string;
};

// ==[HUMAN APPROVED]== The save-as-Character command's extra outcome: the success carries the new
// Character while the Conversation itself stays untouched, so there is no
// snapshot to adopt and the runner forwards it untouched.
type SaveParticipantOperation = {
	kind: "participant-saved";
	character: CharacterSnapshot;
};

// ==[HUMAN APPROVED]== Caller-owned wording for the add-ad-hoc command. The runner owns when each
// notice is shown; the drawer owns what it says.
const ADD_ADHOC_NOTICES = {
	conflict: "The Conversation changed elsewhere; the Cast was reloaded.",
	notFound: CONVERSATION_UNREACHABLE_NOTICE,
	unreachable: CONVERSATION_UNREACHABLE_NOTICE,
};

// ==[HUMAN APPROVED]== Caller-owned wording for the add-from-library command.
const ADD_CHARACTER_NOTICES = {
	conflict: "The Conversation changed elsewhere; the authoritative Cast was reloaded.",
	notFound: "That Character is no longer available.",
	unreachable: LIBRARY_UNREACHABLE_NOTICE,
};

interface CastActionsOptions {
	conversationId: number;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	// ==[HUMAN APPROVED]== The removal confirmation dialog is drawer state; the remove action only
	// closes it before dispatching.
	setRemoveTargetId: (participantId: number | null) => void;
	// ==[HUMAN APPROVED]== The ad-hoc draft is drawer state: the ad-hoc action reads the typed
	// definition and resets it after the Participant was applied.
	adHocDraft: AdHocDraft;
	setAdHocDraft: (draft: AdHocDraft) => void;
}

/**
 * ==[HUMAN APPROVED]== Owns the Cast drawer's four command handlers: remove, add from the
 * Library, add ad hoc, and save-as-Character. Every handler sends through
 * the Conversation command runner, so revision acquisition, exception
 * normalization, snapshot adoption, and the standard notices live in one
 * place; the drawer's typed callbacks keep the precise non-removable and
 * character-library outcomes. Pending state, the ad-hoc draft, the removal
 * dialog, and the save confirmation stay with the drawer.
 */
export function useCastActions({
	conversationId,
	conversation,
	onConversationChange,
	setRemoveTargetId,
	adHocDraft,
	setAdHocDraft,
}: CastActionsOptions) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	// ==[HUMAN APPROVED]== Announces a completed promotion and the navigation action to the new
	// Character Library entry; cleared when the next save attempt starts so
	// the drawer never shows a stale confirmation next to a fresh failure.
	const [saveConfirmation, setSaveConfirmation] = useState<{
		participantLabel: string;
		character: SavedCharacterReference;
	} | null>(null);

	const refreshConversation = async () => {
		try {
			onConversationChange(await loadConversation(conversationId));
		} catch {
			setNotice(CONVERSATION_UNREACHABLE_NOTICE);
		}
	};

	// ==[HUMAN APPROVED]== Removes one unseated Participant after the confirmation dialog. The
	// impact was already shown from the snapshot; the typed not-removable
	// outcome covers the race where Control changed before the command
	// landed.
	const applyRemove = async (participant: {
		id: number;
		duplicateLabel: string;
	}) => {
		if (conversation === null) return;
		setRemoveTargetId(null);
		setPending(true);
		try {
			await runConversationCommand({
				revision: () => conversation.revision,
				send: (expectedRevision) =>
					applyConversationCommand(conversationId, expectedRevision, {
						type: "remove-participant",
						participantId: participant.id,
					}),
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: setNotice,
				},
				notices: {
					conflict: CONVERSATION_CONFLICT_RELOAD_NOTICE,
					notFound: `${participant.duplicateLabel} is no longer in this Cast.`,
					unreachable: CONVERSATION_UNREACHABLE_NOTICE,
				},
				callbacks: {
					onApplied: () => setNotice(null),
					// ==[HUMAN APPROVED]== The seat was taken concurrently, so the presented Cast is
					// stale: the precise wording is paired with an authoritative
					// reload instead of the server reason.
					onNotRemovable: () => {
						setNotice(
							`${participant.duplicateLabel} now holds a Control seat; reassign it before removing.`,
						);
						void refreshConversation();
					},
					onNotPlayable: (reason) => setNotice(reason),
				},
			});
		} finally {
			setPending(false);
		}
	};

	const applyAddCharacter = async (characterId: number, expectedCharacterRevision: number) => {
		if (conversation === null) return;
		setPending(true);
		try {
			await runConversationCommand<AddCharacterOperation>({
				revision: () => conversation.revision,
				send: async (expectedRevision) => {
					const outcome = await addCharacterToCast({
						conversationId,
						expectedConversationRevision: expectedRevision,
						characterId,
						expectedCharacterRevision,
					});
					if (outcome.status === "conflict") {
						if (outcome.currentConversation === undefined) {
							// ==[HUMAN APPROVED]== A library conflict names the changed Character instead of
							// carrying a Conversation snapshot: the runner must not
							// adopt or word it, so it is forwarded as an operation
							// outcome for the drawer's typed callback.
							return {
								status: "operation",
								operation: {
									kind: "character-changed",
									currentCharacterName: outcome.currentCharacterName,
								},
							};
						}
						// ==[HUMAN APPROVED]== A conversation conflict carries the authoritative snapshot.
						return { status: "conflict", currentConversation: outcome.currentConversation };
					}
					return outcome;
				},
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: setNotice,
				},
				notices: ADD_CHARACTER_NOTICES,
				callbacks: {
					onApplied: () => setNotice(null),
					// ==[HUMAN APPROVED]== This command family cannot produce these outcomes; the
					// drawer still words them instead of flattening them.
					onNotPlayable: () => setNotice(LIBRARY_UNREACHABLE_NOTICE),
					onNotRemovable: () => setNotice(LIBRARY_UNREACHABLE_NOTICE),
					onOperation: (operation) => {
						if (operation.kind === "character-changed") {
							void refreshConversation();
							setNotice(
								`${operation.currentCharacterName ?? "The Character"} changed in the Library; the latest Definition was reloaded.`,
							);
						}
					},
				},
			});
		} finally {
			setPending(false);
		}
	};

	const applyAddAdHoc = async () => {
		if (conversation === null) return;
		setPending(true);
		try {
			await runConversationCommand({
				revision: () => conversation.revision,
				send: (expectedRevision) =>
					applyConversationCommand(conversationId, expectedRevision, {
						type: "add-participant",
						definition: {
							name: adHocDraft.name,
							prompt: adHocDraft.prompt,
							openings: openingsFromText(adHocDraft.openingsText),
						},
					}),
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: setNotice,
				},
				notices: ADD_ADHOC_NOTICES,
				callbacks: {
					onApplied: () => {
						setAdHocDraft(emptyAdHocDraft);
						setNotice(null);
					},
					// ==[HUMAN APPROVED]== This command family cannot produce these outcomes; the
					// drawer still words them instead of flattening them.
					onNotPlayable: () => setNotice(CONVERSATION_UNREACHABLE_NOTICE),
					onNotRemovable: () => setNotice(CONVERSATION_UNREACHABLE_NOTICE),
				},
			});
		} finally {
			setPending(false);
		}
	};

	// ==[HUMAN APPROVED]== Saves one active Participant as a new reusable Character. The command
	// carries only the expected Conversation revision and the Participant
	// reference: the authoritative server-side Definition is copied by the
	// workflow, so a stale client copy can never leak into the Library. The
	// Participant, its provenance, and every local draft stay untouched;
	// on success the drawer offers navigation to the new Library entry.
	const applySaveParticipant = async (participant: {
		id: number;
		duplicateLabel: string;
	}) => {
		if (conversation === null) return;
		setSaveConfirmation(null);
		setPending(true);
		try {
			await runConversationCommand<SaveParticipantOperation>({
				revision: () => conversation.revision,
				send: async (expectedRevision) => {
					const outcome = await saveParticipantAsCharacter({
						conversationId,
						expectedConversationRevision: expectedRevision,
						participantId: participant.id,
					});
					// ==[HUMAN APPROVED]== The save workflow leaves the Conversation untouched: the
					// applied outcome carries the new Character and no snapshot
					// to adopt, so it is forwarded as an operation outcome.
					if (outcome.status === "applied") {
						return {
							status: "operation",
							operation: { kind: "participant-saved", character: outcome.character },
						};
					}
					return outcome;
				},
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: setNotice,
				},
				notices: {
					conflict: CONVERSATION_CONFLICT_RELOAD_NOTICE,
					notFound: `${participant.duplicateLabel} is no longer in this Cast.`,
					unreachable: LIBRARY_UNREACHABLE_NOTICE,
				},
				callbacks: {
					// ==[HUMAN APPROVED]== This command family cannot produce these outcomes; the
					// server's precise reason is kept instead of a flattened class.
					onNotPlayable: (reason) => setNotice(reason),
					onNotRemovable: (reason) => setNotice(reason),
					onOperation: (operation) => {
						if (operation.kind === "participant-saved") {
							setSaveConfirmation({
								participantLabel: participant.duplicateLabel,
								character: {
									id: operation.character.id,
									name: operation.character.name,
								},
							});
						}
					},
				},
			});
		} finally {
			setPending(false);
		}
	};

	return {
		pending,
		notice,
		setNotice,
		saveConfirmation,
		applyRemove,
		applyAddCharacter,
		applyAddAdHoc,
		applySaveParticipant,
	};
}
