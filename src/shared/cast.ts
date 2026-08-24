// Pure Cast and Control derivation shared by the server snapshot, the
// workflow seam, and the client UI. Keeping the rules here — rather than
// reimplementing them on each side — means duplicate labels and Control
// assignment semantics can never drift between server and client.

// Computes the display label for the Nth Participant or Character sharing
// one name within its group (Cast order or library order). The first entry
// keeps the plain name; later duplicates receive a visible ordinal. Names
// are never identity keys, so ordinals are the only disambiguation shown.
export const duplicateLabel = (name: string, occurrence: number): string =>
	occurrence <= 1 ? name : `${name} (${occurrence})`;

export type ControlSeat = "human" | "model";

export interface ControlAssignment {
	humanParticipantId: number | null;
	modelParticipantId: number | null;
}

// The kind of change produced by assigning `participantId` to `seat`:
// - "no-change" when the Participant already occupies that seat;
// - "swap" when the assigned Participant is the opposite seat's occupant,
//   so the two assignments exchange atomically;
// - "replace" when an unseated Participant takes over only the chosen seat,
//   leaving the displaced occupant active and removable.
export type ControlChangeKind = "no-change" | "swap" | "replace";

export const resolveControlChange = (
	control: ControlAssignment,
	seat: ControlSeat,
	participantId: number,
): ControlChangeKind => {
	const occupant =
		seat === "human" ? control.humanParticipantId : control.modelParticipantId;
	if (occupant === participantId) return "no-change";
	const opposite =
		seat === "human" ? control.modelParticipantId : control.humanParticipantId;
	if (opposite === participantId) return "swap";
	return "replace";
};