import { useState } from "react";
import { LIBRARY_UNREACHABLE_NOTICE } from "../character-library";
import {
	CONVERSATION_CONFLICT_RELOAD_NOTICE,
	CONVERSATION_UNREACHABLE_NOTICE,
	runConversationCommand,
} from "../conversation-command-runner";
import {
	addCharacterToCast,
	loadConversation,
	saveParticipantAsCharacter,
	type ConversationSummary,
} from "../conversation";
import type { CharacterSnapshot } from "../character-library";
import { controlChangeDescription } from "../cast";
import { emptyPromptChannels } from "../../shared/definition";

// @approved
//  The minimal reference the drawer needs to offer navigation into the new
// Character Library entry. Internal identifiers are not displayed anywhere.
export interface SavedCharacterReference {
	id: number;
	name: string;
}

// @approved
//  The character-library add command's extra outcome: the conflict names the
// changed Character instead of carrying a Conversation snapshot, so the
// runner must not adopt or word it and forwards it untouched.
type AddCharacterOperation = {
	kind: "character-changed";
	currentCharacterName?: string;
};

// @approved
//  The save-as-Character command's extra outcome: the success carries the new
// Character while the Conversation itself stays untouched, so there is no
// snapshot to adopt and the runner forwards it untouched.
type SaveParticipantOperation = {
	kind: "participant-saved";
	character: CharacterSnapshot;
};

const ADD_ADHOC_NOTICES = {
	conflict: "The Conversation changed elsewhere; the Cast was reloaded.",
	notFound: CONVERSATION_UNREACHABLE_NOTICE,
	unreachable: CONVERSATION_UNREACHABLE_NOTICE,
};

// @approved
//  Caller-owned wording for the add-from-library command.
const ADD_CHARACTER_NOTICES = {
	conflict: "The Conversation changed elsewhere; the authoritative Cast was reloaded.",
	notFound: "That Character is no longer available.",
	unreachable: LIBRARY_UNREACHABLE_NOTICE,
};

interface CastActionsOptions {
	conversationId: number;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	// @approved
	//  The removal confirmation dialog is drawer state; the remove action only
	// closes it before dispatching.
	setRemoveTargetId: (participantId: number | null) => void;
}

/** @approved
 * Owns the Characters panel's Cast command handlers: remove, add from the
 * Library, add a blank chat-only Participant, assign a seat, and
 * save-as-Character. Every handler sends through
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
}: CastActionsOptions) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	// @approved
	//  Announces a completed promotion and the navigation action to the new
	// Character Library entry; cleared when the next save attempt starts so
	// the drawer never shows a stale confirmation next to a fresh failure.
	const [saveConfirmation, setSaveConfirmation] = useState<{
		participantLabel: string;
		character: SavedCharacterReference;
	} | null>(null);

	const surface = {
		conversationId,
		revision: () => conversation?.revision ?? null,
		onConversationChange,
		setNotice,
	};

	const refreshConversation = async () => {
		try {
			onConversationChange(await loadConversation(conversationId));
		} catch {
			setNotice(CONVERSATION_UNREACHABLE_NOTICE);
		}
	};

	// @approved
	//  Removes one unseated Participant after the confirmation dialog. The
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
			await runConversationCommand(surface, {
				type: "remove-participant",
				participantId: participant.id,
			}, {
				notices: {
					conflict: CONVERSATION_CONFLICT_RELOAD_NOTICE,
					notFound: `${participant.duplicateLabel} is no longer in this Cast.`,
					unreachable: CONVERSATION_UNREACHABLE_NOTICE,
				},
				onApplied: () => setNotice(null),
				onNotRemovable: () => {
					setNotice(
						`${participant.duplicateLabel} now holds a Control seat; reassign it before removing.`,
					);
					void refreshConversation();
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
			await runConversationCommand<AddCharacterOperation>(surface, async (expectedRevision) => {
				const outcome = await addCharacterToCast({
					conversationId,
					expectedConversationRevision: expectedRevision,
					characterId,
					expectedCharacterRevision,
				});
				if (outcome.outcome === "conflict") {
					if ("currentConversation" in outcome) {
						// @approved
						//  A conversation conflict carries the authoritative snapshot.
						return outcome;
					}
					// @approved
					//  A library conflict names the changed Character instead of
					// carrying a Conversation snapshot: the runner must not
					// adopt or word it, so it is forwarded as an operation
					// outcome for the drawer's typed callback.
					return {
						outcome: "operation",
						operation: {
							kind: "character-changed",
							currentCharacterName: outcome.currentCharacter.name,
						},
					};
				}
				return outcome;
			}, {
				notices: ADD_CHARACTER_NOTICES,
				onApplied: () => setNotice(null),
				onOperation: (operation) => {
					if (operation.kind === "character-changed") {
						void refreshConversation();
						setNotice(
							`${operation.currentCharacterName ?? "The Character"} changed in the Library; the latest Definition was reloaded.`,
						);
					}
				},
			});
		} finally {
			setPending(false);
		}
	};

	const applyAddBlank = async (name: string): Promise<number | null> => {
		if (conversation === null) return null;
		let added: number | null = null;
		setPending(true);
		try {
			await runConversationCommand(surface, {
				type: "add-participant",
				definition: { name, prompt: emptyPromptChannels(), openings: [] },
			}, {
				notices: ADD_ADHOC_NOTICES,
				onApplied: (applied) => {
					added = applied.cast.at(-1)?.id ?? null;
					setNotice(null);
				},
			});
		} finally {
			setPending(false);
		}
		return added;
	};

	const applyAssignSeat = async (seat: "human" | "model", participantId: number) => {
		if (conversation === null || controlChangeDescription(conversation, seat, participantId).kind === "no-change") return;
		setPending(true);
		try {
			await runConversationCommand(surface, { type: "assign-control", seat, participantId }, {
				notices: ADD_ADHOC_NOTICES,
				onApplied: () => setNotice(null),
			});
		} finally {
			setPending(false);
		}
	};

	// @approved
	//  Saves one active Participant as a new reusable Character. The command
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
			await runConversationCommand<SaveParticipantOperation>(surface, async (expectedRevision) => {
				const outcome = await saveParticipantAsCharacter({
					conversationId,
					expectedConversationRevision: expectedRevision,
					participantId: participant.id,
				});
				// @approved
				//  The save workflow leaves the Conversation untouched: the
				// applied outcome carries the new Character and no snapshot
				// to adopt, so it is forwarded as an operation outcome.
				if (outcome.outcome === "available") {
					return {
						outcome: "operation",
						operation: { kind: "participant-saved", character: outcome.value.character },
					};
				}
				return outcome;
			}, {
				notices: {
					conflict: CONVERSATION_CONFLICT_RELOAD_NOTICE,
					notFound: `${participant.duplicateLabel} is no longer in this Cast.`,
					unreachable: LIBRARY_UNREACHABLE_NOTICE,
				},
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
		setSaveConfirmation,
		applyRemove,
		applyAddCharacter,
		applyAddBlank,
		applyAssignSeat,
		applySaveParticipant,
	};
}
