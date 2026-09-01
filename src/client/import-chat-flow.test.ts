import { describe, expect, test } from "bun:test";
import type { ChatImportPreview } from "../shared/contract/chat-import";
import { UNKNOWN_IMPORTED_AUTHOR_NAME as UNKNOWN_NAME } from "../shared/imported-author";
import {
	buildResolvedParticipants,
	canCommit,
	cancelNeedsWarning,
	createChatImportFlowState,
	deriveDuplicateNameWarnings,
	reduceChatImportFlow,
	resolutionReady,
	shouldBeginUpload,
	type ChatImportFlowAction,
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
			messageVariantCounts: [1],
			messageCount: 1,
			variantCount: 1,
			participantNameDefault: "Writer",
			suggestion: suggestion("Writer"),
		},
		{
			key: "",
			isBlank: true,
			messagePositions: [2],
			messageVariantCounts: [1],
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

	const apply = (
		state: ReturnType<typeof reduceChatImportFlow>,
		...actions: ChatImportFlowAction[]
	) => actions.reduce(reduceChatImportFlow, state);

	const resolveBlankSegment = (
		state: ReturnType<typeof reduceChatImportFlow>,
	) =>
		apply(
			state,
			{ type: "suggestion-approved", id: "group-0" },
			{ type: "blank-name-confirmed", id: "group-1" },
			{ type: "title-changed", title: "Lantern House" },
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

	test("builds the staged preview with one segment per exact captured name, pre-filling but never approving suggestions", () => {
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

		expect(state.groups.map((group) => group.id)).toEqual(["group-0", "group-1"]);
		expect(state.groups[0]).toMatchObject({
			key: "Writer",
			messages: [{ position: 1, variantCount: 1, isBlankSource: false }],
			participantName: "Writer",
			suggestedApproved: false,
			outcome: { type: "fork", characterId: 1 },
		});
		// A group without any plausible Character defaults to Chat-only, a
		// complete identity rather than an unresolved placeholder.
		expect(state.groups[1]).toMatchObject({
			isBlank: true,
			participantName: UNKNOWN_NAME,
			blankNameConfirmed: false,
			outcome: { type: "chat-only" },
		});
		expect(state.receipt).toBeNull();
	});

	test("requires explicit approval of a pre-filled Character fork and records the exact outcome", () => {
		let state = toPreview();
		// The pre-filled suggestion alone never passes final review: a fork
		// outcome must be explicitly approved.
		expect(resolutionReady(state)).toBe(false);
		expect(canCommit(state)).toBe(false);

		state = reduceChatImportFlow(state, {
			type: "suggestion-approved",
			id: "group-0",
		});
		expect(state.groups[0]?.suggestedApproved).toBe(true);
		expect(state.groups[0]?.outcome).toEqual({ type: "fork", characterId: 1 });
		expect(resolutionReady(state)).toBe(false); // blank group still pending

		// Choosing a different Character through the picker is an explicit
		// confirmation of that choice; the blank group and title keep the
		// gate from passing until they are resolved too.
		state = apply(state, {
			type: "outcome-changed",
			id: "group-0",
			outcome: { type: "fork", characterId: 7 },
		});
		expect(state.groups[0]?.suggestedApproved).toBe(true);
		expect(state.groups[0]?.outcome).toEqual({ type: "fork", characterId: 7 });

		// Switching to Chat-only or new-Character is an explicit decision
		// that no longer needs any Character approval.
		state = apply(state, {
			type: "outcome-changed",
			id: "group-0",
			outcome: { type: "chat-only" },
		});
		expect(state.groups[0]?.outcome).toEqual({ type: "chat-only" });
		expect(state.groups[0]?.suggestedApproved).toBe(true);
	});

	test("blank captured names cannot commit until the name is confirmed or edited", () => {
		let state = toPreview();
		state = apply(
			state,
			{ type: "suggestion-approved", id: "group-0" },
			{ type: "title-changed", title: "Lantern House" },
		);
		// The blank group carries the editable default but stays unconfirmed.
		expect(state.groups[1]?.blankNameConfirmed).toBe(false);
		expect(resolutionReady(state)).toBe(false);

		// Explicit confirmation of the default passes the gate.
		const confirmed = apply(state, {
			type: "blank-name-confirmed",
			id: "group-1",
		});
		expect(confirmed.groups[1]?.blankNameConfirmed).toBe(true);
		expect(resolutionReady(confirmed)).toBe(true);

		// Editing the name supplies the nonblank usable name (the alternate
		// acceptance path), and a supplied nonblank name is required.
		const edited = apply(state, {
			type: "group-name-changed",
			id: "group-1",
			name: "Stranger",
		});
		expect(edited.groups[1]?.participantName).toBe("Stranger");
		expect(edited.groups[1]?.blankNameConfirmed).toBe(true);
		expect(resolutionReady(edited)).toBe(true);

		const emptied = apply(state, {
			type: "group-name-changed",
			id: "group-1",
			name: "",
		});
		expect(resolutionReady(emptied)).toBe(false);
	});

	test("merges whole captured-name groups into one Participant and undoes the merge", () => {
		// Two extra nonblank groups join the preview so merge has real
		// material: "Writer" (position 1) plus " Writer " (position 3).
		const mergedPreview = preview({
			counts: { messages: 3, variants: 3 },
			groups: [
				{
					key: "Writer",
					isBlank: false,
					messagePositions: [1],
					messageVariantCounts: [1],
					messageCount: 1,
					variantCount: 1,
					participantNameDefault: "Writer",
					suggestion: suggestion("Writer"),
				},
				{
					key: " Writer ",
					isBlank: false,
					messagePositions: [3],
					messageVariantCounts: [2],
					messageCount: 1,
					variantCount: 2,
					participantNameDefault: " Writer ",
					suggestion: null,
				},
				{
					key: "",
					isBlank: true,
					messagePositions: [2],
					messageVariantCounts: [1],
					messageCount: 1,
					variantCount: 1,
					participantNameDefault: UNKNOWN_NAME,
					suggestion: null,
				},
			],
		});
		let state = toPreview({ token: "tok-m", preview: mergedPreview });

		state = apply(state, {
			type: "merge-into",
			targetId: "group-0",
			sourceIds: ["group-1"],
		});
		// The target Participant keeps its identity, name, outcome, and
		// approvals and takes the union of the whole Messages.
		expect(state.groups.map((group) => group.id)).toEqual(["group-0", "group-2"]);
		expect(state.groups[0]).toMatchObject({
			messages: [
				{ position: 1, variantCount: 1, isBlankSource: false },
				{ position: 3, variantCount: 2, isBlankSource: false },
			],
			participantName: "Writer",
			outcome: { type: "fork", characterId: 1 },
		});
		expect(state.history.length).toBe(1);

		// Undo restores the previous segments exactly, including the merged
		// group's own name and the source segment's identity.
		state = reduceChatImportFlow(state, { type: "undo-resolution" });
		expect(state.history.length).toBe(0);
		expect(state.groups.map((group) => group.id)).toEqual([
			"group-0",
			"group-1",
			"group-2",
		]);
		expect(state.groups[1]?.messages.map((message) => message.position)).toEqual([3]);
		expect(state.groups[1]?.messages).toEqual([
			{ position: 3, variantCount: 2, isBlankSource: false },
		]);
	});

	test("splits selected whole Messages into another Participant and undoes the split", () => {
		const splitPreview = preview({
			counts: { messages: 2, variants: 3 },
			groups: [
				{
					key: "Writer",
					isBlank: false,
					messagePositions: [1, 2],
					messageVariantCounts: [2, 1],
					messageCount: 2,
					variantCount: 3,
					participantNameDefault: "Writer",
					suggestion: suggestion("Writer"),
				},
			],
		});
		let state = toPreview({ token: "tok-s", preview: splitPreview });

		// A brand-new Participant receives the selected whole Messages; every
		// Variant stays with its owning Message.
		state = apply(state, {
			type: "split-new",
			fromId: "group-0",
			positions: [2],
			newId: "split-a",
		});
		expect(state.groups.map((group) => group.id)).toEqual(["split-a", "group-0"]);
		expect(state.groups[0]).toMatchObject({
			key: "Writer",
			messages: [{ position: 2, variantCount: 1, isBlankSource: false }],
			participantName: "",
			outcome: { type: "chat-only" },
			blankNameConfirmed: false,
		});
		expect(state.groups[1]).toMatchObject({
			messages: [{ position: 1, variantCount: 2, isBlankSource: false }],
		});
		// The fresh participant must be named before the review can pass.
		expect(resolutionReady(state)).toBe(false);
		state = apply(state, {
			type: "group-name-changed",
			id: "split-a",
			name: "The Other Writer",
		});
		expect(resolutionReady(state)).toBe(false); // pre-filled fork unapproved

		// Undo restores the exact pre-split segments.
		state = reduceChatImportFlow(state, { type: "undo-resolution" });
		expect(state.groups.map((group) => group.id)).toEqual(["group-0"]);
		expect(state.groups[0]?.messages).toEqual([
			{ position: 1, variantCount: 2, isBlankSource: false },
			{ position: 2, variantCount: 1, isBlankSource: false },
		]);
	});

	test("splitting into an existing Participant moves the whole Messages and stays undoable", () => {
		const splitPreview = preview({
			counts: { messages: 3, variants: 3 },
			groups: [
				{
					key: "Writer",
					isBlank: false,
					messagePositions: [1, 3],
					messageVariantCounts: [1, 1],
					messageCount: 2,
					variantCount: 2,
					participantNameDefault: "Writer",
					suggestion: suggestion("Writer"),
				},
				{
					key: "Rulership",
					isBlank: false,
					messagePositions: [2],
					messageVariantCounts: [1],
					messageCount: 1,
					variantCount: 1,
					participantNameDefault: "Rulership",
					suggestion: null,
				},
			],
		});
		let state = toPreview({ token: "tok-x", preview: splitPreview });

		state = apply(state, {
			type: "split-out",
			fromId: "group-0",
			toId: "group-1",
			positions: [1],
		});
		expect(state.groups[0]).toMatchObject({
			messages: [{ position: 3, variantCount: 1, isBlankSource: false }],
		});
		expect(state.groups[1]).toMatchObject({
			messages: [
				{ position: 2, variantCount: 1, isBlankSource: false },
				{ position: 1, variantCount: 1, isBlankSource: false },
			],
		});

		state = reduceChatImportFlow(state, { type: "undo-resolution" });
		expect(state.groups[0]?.messages.map((message) => message.position)).toEqual([1, 3]);
		expect(state.groups[1]?.messages.map((message) => message.position)).toEqual([2]);
	});

	test("moving blank-source Messages carries the blank confirmation requirement to the target", () => {
		let state = toPreview();
		// Move the blank group's Message into the "Writer" segment (a merge
		// via existing-target split), then confirm the blank source once.
		state = apply(state, {
			type: "split-out",
			fromId: "group-1",
			toId: "group-0",
			positions: [2],
		});
		expect(state.groups[0]?.messages).toEqual([
			{ position: 1, variantCount: 1, isBlankSource: false },
			{ position: 2, variantCount: 1, isBlankSource: true },
		]);
		expect(state.groups.map((group) => group.id)).toEqual(["group-0"]);

		// The blank-source flag moved with the Message: the merged segment
		// is blank-affected even though its key is "Writer".
		state = apply(state, {
			type: "suggestion-approved",
			id: "group-0",
		});
		expect(resolutionReady(state)).toBe(false);
		state = apply(state, { type: "blank-name-confirmed", id: "group-0" });
		expect(resolutionReady(state)).toBe(true);
	});

	test("exact duplicates require the explicit import another copy confirmation", () => {
		let state = toPreview({
			token: "tok-d",
			preview: preview({
				duplicates: {
					exact: [{ id: 41, name: "prior" }],
					related: [],
				},
			}),
		});
		state = resolveBlankSegment(state);
		expect(resolutionReady(state)).toBe(true);
		expect(canCommit(state)).toBe(false);

		state = reduceChatImportFlow(state, { type: "duplicate-confirmed", confirmed: true });
		expect(canCommit(state)).toBe(true);

		// Related-source matches are advisory and never gate the commit.
		const related = resolveBlankSegment(
			toPreview({
				token: "tok-r",
				preview: preview({
					duplicates: {
						exact: [],
						related: [{ id: 42, name: "related" }],
					},
				}),
			}),
		);
		expect(canCommit(related)).toBe(true);
	});

	test("review, commit, recoverable failure, and success navigation keep the receipts", () => {
		let state = resolveBlankSegment(toPreview());
		expect(state.phase).toBe("preview");

		state = reduceChatImportFlow(state, { type: "review-ready" });
		expect(state.phase).toBe("review");
		expect(canCommit(state)).toBe(true);

		// Back to resolution keeps every choice and approval.
		state = reduceChatImportFlow(state, { type: "back-to-preview" });
		expect(state.phase).toBe("preview");
		expect(state.groups[0]?.suggestedApproved).toBe(true);
		state = reduceChatImportFlow(state, { type: "review-ready" });

		// The resolved plan is what the transport will commit.
		expect(buildResolvedParticipants(state)).toEqual([
			{ name: "Writer", outcome: { type: "fork", characterId: 1 }, messagePositions: [1] },
			{ name: UNKNOWN_NAME, outcome: { type: "chat-only" }, messagePositions: [2] },
		]);

		state = reduceChatImportFlow(state, { type: "commit-started" });
		expect(state.phase).toBe("committing");

		// A recoverable commit failure reopens the review with every choice
		// intact so the user can correct and retry.
		state = reduceChatImportFlow(state, {
			type: "commit-failed",
			reason: "Every Message must belong to a Participant.",
		});
		expect(state.phase).toBe("review");
		expect(state.problem).toBe("Every Message must belong to a Participant.");
		expect(state.groups[0]?.suggestedApproved).toBe(true);
		expect(state.handle?.token).toBe("tok-1");

		state = reduceChatImportFlow(state, { type: "commit-started" });
		state = reduceChatImportFlow(state, {
			type: "commit-succeeded",
			receipt: {
				conversationId: 9,
				title: "lantern-house",
				originalFilename: "lantern-house.jsonl",
				sha256: "abc123",
				byteLength: 42,
				counts: { messages: 2, variants: 2 },
				participants: [
					{ name: "Writer", outcome: "fork", sourceCharacterId: 1 },
					{ name: UNKNOWN_NAME, outcome: "chat-only", sourceCharacterId: null },
				],
				warnings: [],
				duplicates: { exact: [], related: [] },
			},
		});
		expect(state.phase).toBe("success");
		expect(state.receipt?.conversationId).toBe(9);
		// Success navigation: the receipt step moves straight to closing.
		state = reduceChatImportFlow(state, { type: "success-dismissed" });
		expect(state.phase).toBe("closing");
	});

	test("duplicate Profile names stay allowed and produce visible warnings", () => {
		const state = resolveBlankSegment(toPreview());
		// The new-Character outcome with a name already held by a library
		// Character warns but never blocks; the same for duplicate resolved
		// Participant names.
		const withNewCharacter = apply(state, {
			type: "outcome-changed",
			id: "group-1",
			outcome: { type: "new-character" },
		});
		expect(
			deriveDuplicateNameWarnings(withNewCharacter, [
				{ id: 3, name: UNKNOWN_NAME },
			]),
		).toEqual([
			`A Character named "${UNKNOWN_NAME}" already exists; this import creates a new independent Character with the same name.`,
		]);
		expect(
			deriveDuplicateNameWarnings(withNewCharacter, []),
		).toEqual([]);
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

		state = reduceChatImportFlow(toPreview(), { type: "confirm-cancel" });
		expect(state.phase).toBe("closing");
		expect(state.cancelPending).toBe(false);
		// The token remains available to the view so it can discard the
		// staged handle before closing.
		expect(state.handle?.token).toBe("tok-1");
	});

	test("back from the staged flow returns to choosing without any resolution work", () => {
		const state = reduceChatImportFlow(resolveBlankSegment(toPreview()), {
			type: "back-to-choose",
		});
		expect(state.phase).toBe("choose");
		expect(state.handle).toBeNull();
		expect(state.groups).toEqual([]);
		expect(shouldBeginUpload(state)).toBe(true);
	});

	test("preserves the staged preview and choices after recoverable errors", () => {
		let state = resolveBlankSegment(toPreview());
		state = reduceChatImportFlow(state, { type: "title-changed", title: "Lantern House" });

		state = reduceChatImportFlow(state, {
			type: "preview-failed",
			reason: "The preview could not be refreshed.",
		});
		expect(state.phase).toBe("preview");
		expect(state.problem).toBe("The preview could not be refreshed.");
		expect(state.handle?.token).toBe("tok-1");
		expect(state.title).toBe("Lantern House");
		expect(state.groups[0]?.suggestedApproved).toBe(true);
		expect(shouldBeginUpload(state)).toBe(false);

		// A successful refresh updates preview-derived fields while the
		// approvals and names survive by segment identity.
		const refreshed = reduceChatImportFlow(state, {
			type: "preview-succeeded",
			preview: preview({ counts: { messages: 3, variants: 4 } }),
		});
		expect(refreshed.counts).toEqual({ messages: 3, variants: 4 });
		expect(refreshed.title).toBe("Lantern House");
		expect(refreshed.groups[0]?.suggestedApproved).toBe(true);
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

	test("selected whole Messages stay internal to the resolver model", () => {
		let state = toPreview();
		expect(state.groups[0]?.selectedPositions).toEqual([]);
		state = reduceChatImportFlow(state, {
			type: "message-selected",
			id: "group-0",
			position: 1,
			selected: true,
		});
		expect(state.groups[0]?.selectedPositions).toEqual([1]);
		state = reduceChatImportFlow(state, {
			type: "message-selected",
			id: "group-0",
			position: 1,
			selected: false,
		});
		expect(state.groups[0]?.selectedPositions).toEqual([]);
	});

	test("resolution sorts groups and keeps identities stable across merges", () => {
		// Merging one source into the target keeps the target first in the
		// resolved list; the resulting order is the Participant seed order.
		const mergedPreview = preview({
			counts: { messages: 3, variants: 3 },
			groups: [
				{
					key: "Writer",
					isBlank: false,
					messagePositions: [1],
					messageVariantCounts: [1],
					messageCount: 1,
					variantCount: 1,
					participantNameDefault: "Writer",
					suggestion: suggestion("Writer"),
				},
				{
					key: "",
					isBlank: true,
					messagePositions: [2],
					messageVariantCounts: [1],
					messageCount: 1,
					variantCount: 1,
					participantNameDefault: UNKNOWN_NAME,
					suggestion: null,
				},
				{
					key: " Writer ",
					isBlank: false,
					messagePositions: [3],
					messageVariantCounts: [1],
					messageCount: 1,
					variantCount: 1,
					participantNameDefault: " Writer ",
					suggestion: null,
				},
			],
		});
		let state = toPreview({ token: "tok-o", preview: mergedPreview });
		state = apply(state, {
			type: "merge-into",
			targetId: "group-2",
			sourceIds: ["group-0"],
		});
		// The merged target keeps its identity and moves first; the remaining
		// segments follow in their previous order. Merged position order is
		// target-first, then each source's positions in order.
		expect(state.groups.map((group) => group.messages.map((message) => message.position))).toEqual([
			[3, 1],
			[2],
		]);
		expect(state.groups[0]?.id).toBe("group-2");
		expect(state.groups[1]?.id).toBe("group-1");
	});
});
