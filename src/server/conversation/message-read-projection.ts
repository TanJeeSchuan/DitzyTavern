import type {
	AuthorStampSnapshot,
	HistoricalControlSnapshot,
} from "./types";

// ==[HUMAN APPROVED]== The read models all use the same projection of a Message's immutable author
// stamp and captured historical Control. These operations are deliberately
// pure: callers own the Cast read and pass only its active membership.
export const toAuthorStamp = (
	row: { author_participant_id: number | null; author_name: string | null },
	castIds: ReadonlySet<number>,
): AuthorStampSnapshot | null =>
	row.author_participant_id !== null || row.author_name !== null
		? {
				participantId: row.author_participant_id,
				capturedName: row.author_name,
				inCast:
					row.author_participant_id !== null &&
					castIds.has(row.author_participant_id),
			}
		: null;

export const toHistoricalContext = (
	row: {
		context_human_participant_id: number | null;
		context_model_participant_id: number | null;
	},
): HistoricalControlSnapshot | null =>
	row.context_human_participant_id !== null &&
	row.context_model_participant_id !== null
		? {
				humanParticipantId: row.context_human_participant_id,
				modelParticipantId: row.context_model_participant_id,
			}
		: null;
