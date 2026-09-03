import { describe, expect, test } from "bun:test";
import {
	toAuthorStamp,
	toHistoricalContext,
} from "./message-read-projection";

// The row→view mappers are the one derivation of Message identity shared by
// the snapshot and the paginated history read.
describe("snapshot row mappers", () => {
	describe("toAuthorStamp", () => {
		test("maps an authored row to its stamp with active Cast membership", () => {
			expect(
				toAuthorStamp(
					{ author_participant_id: 7, author_name: "Maren" },
					new Set([7, 9]),
				),
			).toEqual({
				participantId: 7,
				capturedName: "Maren",
				inCast: true,
			});
		});

		test("marks an author no longer in the active Cast", () => {
			expect(
				toAuthorStamp(
					{ author_participant_id: 7, author_name: "Maren" },
					new Set<number>(),
				),
			).toEqual({
				participantId: 7,
				capturedName: "Maren",
				inCast: false,
			});
		});

		test("keeps a captured name whose Participant reference was released", () => {
			expect(
				toAuthorStamp(
					{ author_participant_id: null, author_name: "Ghost" },
					new Set<number>(),
				),
			).toEqual({
				participantId: null,
				capturedName: "Ghost",
				inCast: false,
			});
		});

		test("maps a preservation record without a resolved author to null", () => {
			expect(
				toAuthorStamp(
					{ author_participant_id: null, author_name: null },
					new Set<number>(),
				),
			).toBeNull();
		});
	});

	describe("toHistoricalContext", () => {
		test("maps a captured historical Control pair", () => {
			expect(
				toHistoricalContext({
					context_human_participant_id: 3,
					context_model_participant_id: 4,
				}),
			).toEqual({ humanParticipantId: 3, modelParticipantId: 4 });
		});

		test("never fabricates a pair from a partial captured pair", () => {
			expect(
				toHistoricalContext({
					context_human_participant_id: null,
					context_model_participant_id: 4,
				}),
			).toBeNull();
			expect(
				toHistoricalContext({
					context_human_participant_id: 3,
					context_model_participant_id: null,
				}),
			).toBeNull();
		});
	});
});
