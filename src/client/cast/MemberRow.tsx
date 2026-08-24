export function MemberRow({
	participant,
	seat,
	editing,
	pending,
	onToggleEdit,
	onSaveAsCharacter,
	onRemove,
}: {
	participant: {
		duplicateLabel: string;
		sourceCharacterName: string | null;
		removal: {
			eligible: boolean;
			reason: "control-assigned" | null;
			deletionMode: "hard-delete" | "tombstone" | null;
			affectedGenerationCount: number;
		};
	};
	seat: "human" | "model" | null;
	editing: boolean;
	pending: boolean;
	onToggleEdit: () => void;
	onSaveAsCharacter: () => void;
	onRemove: () => void;
}) {
	const provenance =
		participant.sourceCharacterName !== null
			? `Fork of ${participant.sourceCharacterName}`
			: "Ad-hoc Participant";
	const removable = seat === null && participant.removal.eligible;
	const removalNote =
		seat !== null
			? participant.removal.reason === "control-assigned"
				? "Change a Control seat before this Participant can be removed."
				: "Remove availability is confirmed separately."
			: participant.removal.deletionMode === "tombstone"
				? participant.removal.affectedGenerationCount === 1
					? "Removable; 1 Message loses sibling generation."
					: `Removable; ${participant.removal.affectedGenerationCount} Messages lose sibling generation.`
				: "Removable: no history refers to it; removal hard-deletes it.";

	return (
		<div className="cast-member">
			<div className="cast-member-copy">
				<strong>{participant.duplicateLabel}</strong>
				<span>{provenance}</span>
				<span>{removalNote}</span>
			</div>
			<div className="cast-member-right">
				{seat !== null && (
					<span className="control-badge" data-seat={seat}>
						{seat === "human" ? "Human" : "Model"}
					</span>
				)}
				<button
					className="secondary-button cast-edit-button"
					type="button"
					disabled={pending}
					onClick={onToggleEdit}
					aria-expanded={editing}
				>
					{editing ? "Close" : "Edit"}
				</button>
				<button
					className="secondary-button cast-save-button"
					type="button"
					disabled={pending}
					onClick={onSaveAsCharacter}
				>
					Save as Character
				</button>
				{removable && (
					<button
						className="secondary-button cast-remove-button"
						type="button"
						disabled={pending}
						onClick={onRemove}
					>
						Remove
					</button>
				)}
			</div>
		</div>
	);
}

