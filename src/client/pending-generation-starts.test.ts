import { describe, expect, test } from "bun:test";
import {
	createPendingGenerationStarts,
	reducePendingGenerationStarts,
} from "./pending-generation-starts";

describe("pending Generation starts", () => {
	test("overlapping starts hand off independently when their sessions arrive out of order", () => {
		let starts = createPendingGenerationStarts();
		starts = reducePendingGenerationStarts(starts, { type: "started", startId: 1 });
		starts = reducePendingGenerationStarts(starts, { type: "started", startId: 2 });
		starts = reducePendingGenerationStarts(starts, {
			type: "accepted",
			startId: 2,
			generationId: 202,
		});
		starts = reducePendingGenerationStarts(starts, {
			type: "sessions-observed",
			generationIds: new Set([202]),
		});

		expect([...starts]).toEqual([[1, null]]);

		starts = reducePendingGenerationStarts(starts, {
			type: "accepted",
			startId: 1,
			generationId: 101,
		});
		starts = reducePendingGenerationStarts(starts, {
			type: "sessions-observed",
			generationIds: new Set([101, 202]),
		});

		expect(starts.size).toBe(0);
	});

	test("a late result from an old Conversation cannot retire a new start", () => {
		let starts = createPendingGenerationStarts();
		starts = reducePendingGenerationStarts(starts, { type: "started", startId: 1 });
		starts = reducePendingGenerationStarts(starts, { type: "conversation-switched" });
		starts = reducePendingGenerationStarts(starts, { type: "started", startId: 2 });
		starts = reducePendingGenerationStarts(starts, { type: "settled", startId: 1 });

		expect([...starts]).toEqual([[2, null]]);
	});
});
