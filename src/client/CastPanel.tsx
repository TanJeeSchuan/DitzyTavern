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
import { removalConfirmationCopy } from "./cast-remove";
import { listCharacters, type CharacterSummary } from "./character-library";
import type { ConversationSummary } from "./conversation";
import { useCastActions } from "./cast/useCastActions";

// ==[HUMAN APPROVED]== Conversation-local Cast drawer: ordered Participants with computed
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
	// ==[HUMAN APPROVED]== Navigates to a specific Character Library entry, offered after a
	// Participant has been saved as a new Character. The user stays in the
	// Chat until they choose to follow it.
	onOpenLibraryCharacter: (characterId: number) => void;
}
import {
	emptyAdHocDraft,
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
	// ==[HUMAN APPROVED]== Identifies the Participant whose removal confirmation dialog is open.
	// The confirmation copy is derived from the snapshot's removal impact
	// (deletion mode and affected-generation count) shown before dispatch.
	const [removeTargetId, setRemoveTargetId] = useState<number | null>(null);
	const [adHocDraft, setAdHocDraft] = useState<AdHocDraft>(emptyAdHocDraft);

	const {
		pending,
		notice,
		setNotice,
		saveConfirmation,
		applyRemove,
		applyAddCharacter,
		applyAddAdHoc,
		applySaveParticipant,
	} = useCastActions({
		conversationId,
		conversation,
		onConversationChange,
		setRemoveTargetId,
		adHocDraft,
		setAdHocDraft,
	});

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

	// ==[HUMAN APPROVED]== Removes the targeted unseated Participant after an explicit confirmation
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
