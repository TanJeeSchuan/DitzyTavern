import { useState } from "react";
import { presentRemovalOutcome } from "../cast-remove";
import {
	presentSaveParticipantOutcome,
	type SavedCharacterReference,
} from "../cast-save";
import {
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
import { emptyAdHocDraft, openingsFromText, type AdHocDraft } from "./definition";

interface CastActionsOptions {
	conversationId: number;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	// The removal confirmation dialog is drawer state; the remove action only
	// closes it before dispatching.
	setRemoveTargetId: (participantId: number | null) => void;
	// The ad-hoc draft is drawer state: the ad-hoc action reads the typed
	// definition and resets it after the Participant was applied.
	adHocDraft: AdHocDraft;
	setAdHocDraft: (draft: AdHocDraft) => void;
}

/**
 * Owns the Cast drawer's four command handlers: remove, add from the
 * Library, add ad hoc, and save-as-Character. Each handler words its typed
 * outcomes through the cast-remove/cast-save presentation helpers and the
 * shared outcome notices, reloads the authoritative Conversation when the
 * presented state is stale, and reports failures through the drawer notice.
 * The drawer keeps its rendering state (picker, drafts, dialogs) and wires
 * these actions to its controls.
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
	// Announces a completed promotion and the navigation action to the new
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

	const runCommand = async (
		run: () => Promise<{ ok: boolean; message?: string }>,
	) => {
		setPending(true);
		try {
			const outcome = await run();
			if (!outcome.ok && outcome.message) {
				setNotice(outcome.message);
			}
		} finally {
			setPending(false);
		}
	};

	// Removes one unseated Participant after the confirmation dialog. The
	// impact was already shown from the snapshot; the typed not-removable
	// outcome covers the race where Control changed before the command
	// landed, and the authoritative Cast is reloaded after it.
	const applyRemove = async (participant: {
		id: number;
		duplicateLabel: string;
	}) => {
		if (conversation === null) return;
		setRemoveTargetId(null);
		await runCommand(async () => {
			const outcome = await applyConversationCommand(
				conversationId,
				conversation.revision,
				{ type: "remove-participant", participantId: participant.id },
			);
			const presentation = presentRemovalOutcome(
				outcome,
				participant.duplicateLabel,
			);
			if (presentation.reloadConversation) {
				await refreshConversation();
			}
			if (outcome.status === "applied") {
				onConversationChange(outcome.conversation);
				setNotice(null);
				return { ok: true };
			}
			if (presentation.notice !== null) {
				return { ok: false, message: presentation.notice };
			}
			return { ok: true };
		});
	};

	const applyAddCharacter = async (characterId: number, expectedRevision: number) => {
		if (conversation === null) return;
		await runCommand(async () => {
			const outcome = await addCharacterToCast({
				conversationId,
				expectedConversationRevision: conversation.revision,
				characterId,
				expectedCharacterRevision: expectedRevision,
			});
			switch (outcome.status) {
				case "applied":
					onConversationChange(outcome.conversation);
					setNotice(null);
					return { ok: true };
				case "conflict":
					if (outcome.currentConversation !== undefined) {
						onConversationChange(outcome.currentConversation);
						return {
							ok: false,
							message:
								"The Conversation changed elsewhere; the authoritative Cast was reloaded.",
						};
					}
					await refreshConversation();
					return {
						ok: false,
						message: `${outcome.currentCharacterName ?? "The Character"} changed in the Library; the latest Definition was reloaded.`,
					};
				case "not-found":
					await refreshConversation();
					return { ok: false, message: "That Character is no longer available." };
				case "invalid":
					return { ok: false, message: outcome.reason };
				default:
					return { ok: false, message: LIBRARY_UNREACHABLE_NOTICE };
			}
		});
	};

	const applyAddAdHoc = async () => {
		if (conversation === null) return;
		await runCommand(async () => {
			const outcome = await applyConversationCommand(
				conversationId,
				conversation.revision,
				{
					type: "add-participant",
					definition: {
						name: adHocDraft.name,
						prompt: adHocDraft.prompt,
						openings: openingsFromText(adHocDraft.openingsText),
					},
				},
			);
			switch (outcome.status) {
				case "applied":
					onConversationChange(outcome.conversation);
					setAdHocDraft(emptyAdHocDraft);
					setNotice(null);
					return { ok: true };
				case "conflict":
					onConversationChange(outcome.currentConversation);
					return {
						ok: false,
						message: "The Conversation changed elsewhere; the Cast was reloaded.",
					};
				case "invalid":
					return { ok: false, message: outcome.reason };
				default:
					return { ok: false, message: CONVERSATION_UNREACHABLE_NOTICE };
			}
		});
	};

	// Saves one active Participant as a new reusable Character. The command
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
		await runCommand(async () => {
			const outcome = await saveParticipantAsCharacter({
				conversationId,
				expectedConversationRevision: conversation.revision,
				participantId: participant.id,
			});
			const presentation = presentSaveParticipantOutcome(
				outcome,
				participant.duplicateLabel,
			);
			if (presentation.savedCharacter !== null) {
				setSaveConfirmation({
					participantLabel: participant.duplicateLabel,
					character: presentation.savedCharacter,
				});
			}
			if (presentation.reloadConversation) {
				await refreshConversation();
			}
			if (presentation.notice !== null) {
				return { ok: false, message: presentation.notice };
			}
			return { ok: true };
		});
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
