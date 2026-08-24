import { UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { libraryPickerEntries } from "./cast";
import { presentRemovalOutcome, removalConfirmationCopy } from "./cast-remove";
import {
	presentSaveParticipantOutcome,
	type SavedCharacterReference,
} from "./cast-save";
import { listCharacters, type CharacterSummary } from "./character-library";
import {
	addCharacterToCast,
	applyConversationCommand,
	loadConversation,
	saveParticipantAsCharacter,
	type ConversationSummary,
} from "./conversation";

// Conversation-local Cast drawer: ordered Participants with computed
// duplicate labels, Control badges, Character provenance, and the actions
// currently allowed for each one. Participants are appended from a
// pinned-first alphabetic Character picker (with ordinals, Prompt previews,
// and used-counts) or from an ad-hoc complete Definition. Removing
// Participants is a separate confirmed flow; eligibility is derived by the
// server snapshot and displayed here. Any active Participant with a
// complete Definition can be promoted into a new reusable Character without
// leaving the Chat.

interface CastPanelProps {
	conversationId: number;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	// Navigates to a specific Character Library entry, offered after a
	// Participant has been saved as a new Character. The user stays in the
	// Chat until they choose to follow it.
	onOpenLibraryCharacter: (characterId: number) => void;
}
import {
	emptyAdHocDraft,
	openingsFromText,
	type AdHocDraft,
} from "./cast/definition";
import { AddParticipant } from "./cast/AddParticipant";
import { MemberRow } from "./cast/MemberRow";
import { ParticipantEditor } from "./cast/ParticipantEditor";

export function CastPanel({
	conversationId,
	conversation,
	onConversationChange,
	onOpenLibraryCharacter,
}: CastPanelProps) {
	const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
	const [adding, setAdding] = useState<"library" | "adhoc" | null>(null);
	const [editingParticipantId, setEditingParticipantId] = useState<number | null>(
		null,
	);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// Identifies the Participant whose removal confirmation dialog is open.
	// The confirmation copy is derived from the snapshot's removal impact
	// (deletion mode and affected-generation count) shown before dispatch.
	const [removeTargetId, setRemoveTargetId] = useState<number | null>(null);
	const [adHocDraft, setAdHocDraft] = useState<AdHocDraft>(emptyAdHocDraft);
	// Announces a completed promotion and the navigation action to the new
	// Character Library entry; cleared when the next save attempt starts so
	// the drawer never shows a stale confirmation next to a fresh failure.
	const [saveConfirmation, setSaveConfirmation] = useState<{
		participantLabel: string;
		character: SavedCharacterReference;
	} | null>(null);

	const loadCharacters = useCallback(async () => {
		try {
			setCharacters(await listCharacters());
		} catch {
			setCharacters([]);
		}
	}, []);

	useEffect(() => {
		void loadCharacters();
	}, [loadCharacters]);

	const refreshConversation = useCallback(async () => {
		try {
			onConversationChange(await loadConversation(conversationId));
		} catch {
			setNotice("The Conversation could not be reached.");
		}
	}, [conversationId, onConversationChange]);

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

	const pickerEntries = useMemo(
		() => libraryPickerEntries(characters ?? [], conversation?.cast ?? []),
		[characters, conversation],
	);

	if (conversation === null) {
		return (
			<div className="panel-body">
				<p className="panel-intro">Loading the Cast…</p>
			</div>
		);
	}

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
					return { ok: false, message: "The Library could not be reached." };
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
					return { ok: false, message: "The Conversation could not be reached." };
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

	// Removes the targeted unseated Participant after an explicit confirmation
	// showing the snapshot-derived impact (hard delete versus tombstone and
	// the exact regeneration loss). Success refreshes Control, ordering,
	// history labels, and capabilities from the authoritative snapshot.
	const removeTarget =
		removeTargetId !== null
			? (conversation.cast.find(
					(participant) => participant.id === removeTargetId,
				) ?? null)
			: null;
	const removeConfirmation =
		removeTarget !== null
			? removalConfirmationCopy(removeTarget.duplicateLabel, removeTarget.removal)
			: null;

	return (
		<div className="panel-body">
			<p className="panel-intro">
				Cast members are local to this Chat. The composer's Writing as and
				Responding as selectors assign the two Control seats.
			</p>

			<button
				className="secondary-button library-new-button"
				type="button"
				aria-expanded={adding !== null}
				onClick={() => {
					setAdding(adding !== null ? null : "library");
					setNotice(null);
				}}
			>
				<UserPlus aria-hidden="true" />
				{adding !== null ? "Close add Participant" : "Add Participant"}
			</button>

			{adding !== null && (
				<AddParticipant
					mode={adding}
					charactersEmpty={characters !== null && characters.length === 0}
					pickerEntries={pickerEntries}
					pending={pending}
					draft={adHocDraft}
					onModeChange={(mode) => {
						setAdding(mode);
						setNotice(null);
					}}
					onDraftChange={setAdHocDraft}
					onAddCharacter={(characterId, revision) =>
						void applyAddCharacter(characterId, revision)
					}
					onAddAdHoc={() => void applyAddAdHoc()}
				/>
			)}

			{notice !== null && (
				<p className="panel-note" role="status">
					{notice}
				</p>
			)}

			{saveConfirmation !== null && (
				<div className="save-character-confirmation" role="status">
					<p>
						Saved {saveConfirmation.participantLabel} as a new Character,{" "}
						<strong>{saveConfirmation.character.name}</strong>. The Participant stays
						local to this Chat; the Character and Participant are independent.
					</p>
					<button
						className="secondary-button"
						type="button"
						onClick={() => onOpenLibraryCharacter(saveConfirmation.character.id)}
					>
						View in Library
					</button>
				</div>
			)}

			{conversation.cast.length === 0 ? (
				<p className="panel-note">This Conversation has no Cast members yet.</p>
			) : (
				<ul className="cast-list">
					{conversation.cast.map((participant) => {
						const seat =
							participant.id === conversation.control.humanParticipantId
								? "human"
								: participant.id === conversation.control.modelParticipantId
									? "model"
									: null;
						const editing = editingParticipantId === participant.id;
						return (
							<li key={participant.id}>
								<MemberRow
									participant={participant}
									seat={seat}
									editing={editing}
									pending={pending}
									onToggleEdit={() =>
										setEditingParticipantId(editing ? null : participant.id)
									}
									onSaveAsCharacter={() =>
										void applySaveParticipant(participant)
									}
									onRemove={() => setRemoveTargetId(participant.id)}
								/>
								{editing && (
									<ParticipantEditor
										conversationId={conversationId}
										conversation={conversation}
										participantId={participant.id}
										onConversationChange={onConversationChange}
										onNotice={setNotice}
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{removeTarget !== null && removeConfirmation !== null && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setRemoveTargetId(null);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{removeConfirmation.title}</DialogTitle>
							<DialogDescription>{removeConfirmation.impact}</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<button
								className="secondary-button"
								type="button"
								disabled={pending}
								onClick={() => setRemoveTargetId(null)}
							>
								Cancel
							</button>
							<button
								className="primary-button"
								type="button"
								disabled={pending || removeConfirmation.confirmLabel === "Close"}
								onClick={() => {
									if (removeTarget !== null) {
										void applyRemove(removeTarget);
									}
								}}
							>
								{removeConfirmation.confirmLabel}
							</button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}
