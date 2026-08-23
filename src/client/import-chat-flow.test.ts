import { describe, expect, test } from "bun:test";
import type { ChatImportPreview } from "./import-chat";
import {
	UNKNOWN_IMPORTED_AUTHOR_NAME as UNKNOWN_NAME,
	allSuggestionsConfirmed,
	cancelNeedsWarning,
	createChatImportFlowState,
	reduceChatImportFlow,
	shouldBeginUpload,
} from "./import-chat-flow";

const suggestion = (name: string, characterId = 1) => ({
	characterId,
	name,
	match: "exact" as const,
	confirmed: false,
});

const preview = (overrides: Partial<ChatImportPreview> = {}): ChatImportPreview => ({
	title: "lantern-house",
	originalFilename: "lantern-house.jsonl",
	sha256: "abc123",
	byteLength: 42,
	integrity: null,
	counts: { messages: 2, variants: 2 },
	warnings: [],
	groups: [
		{
			key: "Writer",
			isBlank: false,
			messagePositions: [1],
			messageCount: 1,
			variantCount: 1,
			participantNameDefault: "Writer",
			suggestion: suggestion("Writer"),
		},
		{
			key: "",
			isBlank: true,
			messagePositions: [2],
			messageCount: 1,
			variantCount: 1,
			participantNameDefault: UNKNOWN_NAME,
			suggestion: null,
		},
	],
	duplicates: { exact: [], related: [] },
	...overrides,
});

describe("reduceChatImportFlow", () => {
	// Realistic staged flow: the single upload runs from the choosing step.
	const toPreview = (
		stage: { token: string; preview: ChatImportPreview } = {
			token: "tok-1",
			preview: preview(),
		},
	) =>
		reduceChatImportFlow(
			reduceChatImportFlow(createChatImportFlowState(), {
				type: "file-chosen",
			}),
			{ type: "stage-succeeded", stage },
		);

	test("starts in choosing and starts the single upload only from there", () => {
		let state = createChatImportFlowState();
		expect(state.phase).toBe("choose");
		expect(shouldBeginUpload(state)).toBe(true);
		expect(cancelNeedsWarning(state)).toBe(false);

		state = reduceChatImportFlow(state, { type: "file-chosen" });
		expect(state.phase).toBe("staging");
		// A second trigger (for example a double event) cannot re-upload.
		state = reduceChatImportFlow(state, { type: "file-chosen" });
		expect(state.phase).toBe("staging");
		expect(shouldBeginUpload(state)).toBe(false);
	});

	test("builds the staged preview with exact groups and unconfirmed pre-filled suggestions", () => {
		const state = toPreview();

		expect(state.phase).toBe("preview");
		expect(state.handle).toEqual({
			token: "tok-1",
			sha256: "abc123",
			originalFilename: "lantern-house.jsonl",
			byteLength: 42,
			integrity: null,
		});
		expect(state.title).toBe("lantern-house");
		expect(state.counts).toEqual({ messages: 2, variants: 2 });

		// One draft per exact captured author string; blank groups surface
		// explicitly with the editable Unknown imported author default.
		expect(state.groups.map((group) => group.key)).toEqual(["Writer", ""]);
		expect(state.groups[0]).toMatchObject({
			participantName: "Writer",
			confirmed: false,
			suggestion: { name: "Writer", match: "exact", confirmed: false },
		});
		expect(state.groups[1]).toMatchObject({
			isBlank: true,
			participantName: UNKNOWN_NAME,
			suggestion: null,
		});
		expect(allSuggestionsConfirmed(state)).toBe(false);

		// Explicit approval is the only way the suggestion gate passes.
		const confirmed = reduceChatImportFlow(state, {
			type: "suggestion-confirmed",
			key: "Writer",
		});
		expect(confirmed.groups[0]?.confirmed).toBe(true);
		expect(allSuggestionsConfirmed(confirmed)).toBe(true);
	});

	test("preserves the staged preview and choices after recoverable errors", () => {
		let state = toPreview();
		state = reduceChatImportFlow(state, { type: "title-changed", title: "Lantern House" });
		state = reduceChatImportFlow(state, {
			type: "group-name-changed",
			key: "Writer",
			name: "The Writer",
		});
		state = reduceChatImportFlow(state, {
			type: "suggestion-confirmed",
			key: "Writer",
		});

		// A recoverable preview failure keeps everything: token, hash, the
		// staged preview, and every choice made during this open flow.
		state = reduceChatImportFlow(state, {
			type: "preview-failed",
			reason: "The preview could not be refreshed.",
		});
		expect(state.phase).toBe("preview");
		expect(state.problem).toBe("The preview could not be refreshed.");
		expect(state.handle?.token).toBe("tok-1");
		expect(state.handle?.sha256).toBe("abc123");
		expect(state.title).toBe("Lantern House");
		expect(state.groups[0]?.participantName).toBe("The Writer");
		expect(state.groups[0]?.confirmed).toBe(true);
		// No re-upload is needed: the flow works from token and hash alone.
		expect(shouldBeginUpload(state)).toBe(false);

		// A successful refresh updates preview-derived fields while user
		// edits and approvals survive by exact group key.
		const refreshed = reduceChatImportFlow(state, {
			type: "preview-succeeded",
			preview: preview({ counts: { messages: 3, variants: 4 } }),
		});
		expect(refreshed.counts).toEqual({ messages: 3, variants: 4 });
		expect(refreshed.title).toBe("Lantern House");
		expect(refreshed.groups[0]?.participantName).toBe("The Writer");
		expect(refreshed.groups[0]?.confirmed).toBe(true);
		expect(refreshed.groups[1]?.participantName).toBe(UNKNOWN_NAME);
	});

	test("stage failures return to choosing with the contextual reason and no token", () => {
		const state = reduceChatImportFlow(
			reduceChatImportFlow(createChatImportFlowState(), {
				type: "file-chosen",
			}),
			{ type: "stage-failed", reason: "Line 2 is not valid JSON." },
		);
		expect(state.phase).toBe("choose");
		expect(state.problem).toBe("Line 2 is not valid JSON.");
		expect(state.handle).toBeNull();
		expect(shouldBeginUpload(state)).toBe(true);
	});

	test("cancel warns only before discarding an open flow and ends in closing", () => {
		const choosing = reduceChatImportFlow(createChatImportFlowState(), {
			type: "cancel-requested",
		});
		expect(choosing.cancelPending).toBe(true);
		expect(cancelNeedsWarning(choosing)).toBe(false);

		let state = reduceChatImportFlow(createChatImportFlowState(), {
			type: "file-chosen",
		});
		expect(cancelNeedsWarning(state)).toBe(true);
		state = reduceChatImportFlow(state, { type: "cancel-requested" });
		expect(state.cancelPending).toBe(true);
		// The warning can be abandoned without losing the staged flow.
		state = reduceChatImportFlow(state, { type: "cancel-abandoned" });
		expect(state.cancelPending).toBe(false);
		expect(state.phase).toBe("staging");

		state = reduceChatImportFlow(
			toPreview(),
			{ type: "confirm-cancel" },
		);
		expect(state.phase).toBe("closing");
		expect(state.cancelPending).toBe(false);
		// The token remains available to the view so it can discard the
		// staged handle before closing.
		expect(state.handle?.token).toBe("tok-1");
	});

	test("back from the staged preview returns to choosing without the staged handle", () => {
		const state = reduceChatImportFlow(toPreview(), {
			type: "back-to-choose",
		});
		expect(state.phase).toBe("choose");
		expect(state.handle).toBeNull();
		expect(state.groups).toEqual([]);
		expect(shouldBeginUpload(state)).toBe(true);
	});
});