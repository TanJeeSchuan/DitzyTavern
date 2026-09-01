// Pure state transitions for the Import Chat flow. The view orchestrates
// the replaceable import client and feeds typed outcomes back into this
// reducer, so every step (choose, upload-once staging, staged preview,
// Participant resolution, final review, commit, receipt, cancel warning,
// discard) is testable without a browser or a frontend framework. No browser
// File reference ever lives in the state: after the initial upload the flow
// works from the staged token and SHA-256 alone.
//
// Resolution model: the preview contributes one working segment per exact
// captured author string. The user can merge whole segments into one
// Participant, split selected whole Messages into another existing segment
// or into a brand-new segment (all Variants stay with their owning Message),
// and undo either operation before commit. Every resulting segment carries
// exactly one of the three resolution outcomes — fork an existing Actor
// Profile, create a new Character together with the Participant, or keep a
// complete Chat-only Participant. No skip, source-role inference, or later
// re-assignment alternative exists.

import type {
	ChatImportDuplicateMatch,
	ChatImportGroup,
	ChatImportPreview,
	ChatImportReceipt,
	ChatImportSuggestion,
	ImportResolutionOutcome,
} from "../shared/contract/chat-import";

export type ChatImportPhase =
	| "choose"
	| "staging"
	| "preview"
	| "review"
	| "committing"
	| "success"
	| "closing";

export interface ImportMessageRecord {
	position: number;
	variantCount: number;
	isBlankSource: boolean;
}

// One working segment of the resolution. Whole Messages are carried as
// records so their position, Variant count, and blank-source marker cannot
// drift apart during a merge or split.
export interface ImportGroupDraft {
	// Stable local identity, since a split produces two segments sharing one
	// exact captured author key.
	id: string;
	// The exact captured author string this segment is primarily associated
	// with; the empty string for blank captured names.
	key: string;
	isBlank: boolean;
	// Blank-source Messages require an explicit usable Participant name before
	// commit, wherever they end up after merge or split.
	messages: ImportMessageRecord[];
	// Editable native Participant name.
	participantName: string;
	// Strongest name-only Character suggestion, unconfirmed; null when the
	// initial group (or the library) had nothing to suggest.
	suggestion: ChatImportSuggestion | null;
	// A fork outcome must be explicitly approved: the pre-filled suggestion
	// alone never passes final review, and picking a Character from the
	// picker counts as the explicit approval.
	suggestedApproved: boolean;
	// Blank-source confirmation: confirmed by the user explicitly, or by
	// editing this segment's Participant name (supplying a nonblank name).
	blankNameConfirmed: boolean;
	outcome: ImportResolutionOutcome;
	// View-local multi-selection of whole Messages for splitting.
	selectedPositions: number[];
}

export const variantCountForGroup = (group: ImportGroupDraft): number =>
	group.messages.reduce((total, message) => total + message.variantCount, 0);

// The staged handle and its binding, set once when the upload succeeds.
// Every preview refresh, commit, and discard works from this handle alone;
// it is never reconstructed from a browser path.
export interface StagedChatHandle {
	token: string;
	sha256: string;
	originalFilename: string;
	byteLength: number;
	integrity: string | null;
}

export interface ChatImportFlowState {
	phase: ChatImportPhase;
	// True while the Cancel warning is shown before discarding the flow.
	cancelPending: boolean;
	// Contextual problem text; recoverable errors keep the staged preview
	// and every choice made during this flow.
	problem: string | null;
	handle: StagedChatHandle | null;
	title: string;
	counts: { messages: number; variants: number } | null;
	warnings: string[];
	duplicates: {
		exact: ChatImportDuplicateMatch[];
		related: ChatImportDuplicateMatch[];
	};
	groups: ImportGroupDraft[];
	// Explicit Import another copy confirmation for exact duplicates; only
	// matching SHA-256 demands it, related-source matches stay advisory.
	duplicateConfirmed: boolean;
	// Segment snapshots pushed before every structural merge/split so the
	// user can undo resolution changes before commit.
	history: ImportGroupDraft[][];
	// Compact receipt of the committed import, shown by the success step.
	receipt: ChatImportReceipt | null;
}

export type ChatImportFlowAction =
	| { type: "begin" }
	// The user chose exactly one file; the view starts the single upload.
	| { type: "file-chosen" }
	| { type: "stage-succeeded"; stage: { token: string; preview: ChatImportPreview } }
	// A validation failure: no token exists, so the flow returns to choosing
	// with the contextual reason intact.
	| { type: "stage-failed"; reason: string }
	// Recoverable preview refresh with the same token and hash: preview
	// fields update while the user's edits and approvals survive.
	| { type: "preview-succeeded"; preview: ChatImportPreview }
	| { type: "preview-failed"; reason: string }
	| { type: "title-changed"; title: string }
	| { type: "group-name-changed"; id: string; name: string }
	| { type: "outcome-changed"; id: string; outcome: ImportResolutionOutcome }
	// Explicitly approves the pre-filled Character suggestion for a fork.
	| { type: "suggestion-approved"; id: string }
	// Explicit confirmation of a blank-source Participant's current name.
	| { type: "blank-name-confirmed"; id: string }
	// Toggles whole-Message selection for a split.
	| { type: "message-selected"; id: string; position: number; selected: boolean }
	// Merges whole segments into one Participant; the target keeps its
	// identity, name, outcome, and approvals, and takes the union of Messages.
	| { type: "merge-into"; targetId: string; sourceIds: string[] }
	// Moves selected whole Messages into an existing segment.
	| { type: "split-out"; fromId: string; toId: string; positions: number[] }
	// Moves selected whole Messages into a brand-new segment with a fresh id.
	| { type: "split-new"; fromId: string; positions: number[]; newId: string }
	// Reverts the last structural merge/split, restoring the previous
	// segments exactly.
	| { type: "undo-resolution" }
	| { type: "duplicate-confirmed"; confirmed: boolean }
	// Final-review navigation, keeping every resolution choice.
	| { type: "review-ready" }
	| { type: "back-to-preview" }
	| { type: "commit-started" }
	| { type: "commit-succeeded"; receipt: ChatImportReceipt }
	// Recoverable commit failure: review stays open with every choice intact.
	| { type: "commit-failed"; reason: string }
	// The success receipt is dismissed; the host closes the flow.
	| { type: "success-dismissed" }
	| { type: "cancel-requested" }
	| { type: "cancel-abandoned" }
	| { type: "confirm-cancel" }
	// Back from preview or review to file selection; the view discards the
	// old token before dispatching this.
	| { type: "back-to-choose" }
	| { type: "reset" };

export const createChatImportFlowState = (): ChatImportFlowState => ({
	phase: "choose",
	cancelPending: false,
	problem: null,
	handle: null,
	title: "",
	counts: null,
	warnings: [],
	duplicates: { exact: [], related: [] },
	groups: [],
	duplicateConfirmed: false,
	history: [],
	receipt: null,
});

const cloneGroups = (groups: readonly ImportGroupDraft[]): ImportGroupDraft[] =>
	groups.map((group) => ({
		...group,
		messages: group.messages.map((message) => ({ ...message })),
		selectedPositions: [...group.selectedPositions],
		suggestion: group.suggestion === null ? null : { ...group.suggestion },
	}));

const draftFromGroup = (
	group: ChatImportGroup,
	index: number,
): ImportGroupDraft => ({
	id: `group-${index}`,
	key: group.key,
	isBlank: group.isBlank,
	// A blank captured group's Messages are all blank-source; nonblank
	// groups carry no blank-source Messages until later splits move some in.
	messages: group.messagePositions.map((position, index) => ({
		position,
		variantCount: group.messageVariantCounts[index] ?? 0,
		isBlankSource: group.isBlank,
	})),
	participantName: group.participantNameDefault,
	suggestion: group.suggestion === null ? null : { ...group.suggestion },
	// The strongest suggestion is pre-filled but never auto-approved.
	suggestedApproved: false,
	// Blank captured names start unconfirmed: the default name alone never
	// passes final review.
	blankNameConfirmed: !group.isBlank,
	outcome:
		group.suggestion === null
			? { type: "chat-only" }
			: { type: "fork", characterId: group.suggestion.characterId },
	selectedPositions: [],
});

const hasBlankSource = (group: ImportGroupDraft): boolean =>
	group.messages.some((message) => message.isBlankSource);

// Single preview/review-phase guard shared by every case that only applies
// while a staged preview is open; the guard helper keeps the repeated switch
// checks in one place.
const inStagedFlow = (state: ChatImportFlowState): boolean =>
	state.phase === "preview" || state.phase === "review";

// Merges a refreshed preview into the working segments: preview-derived
// fields update, while the user's editable names, approvals, outcomes, and
// structural merge/split choices survive by segment identity. A segment
// that still exactly matches its initial preview group refreshes its
// name-only suggestion; restructured segments are left untouched.
const mergePreviewGroups = (
	existing: readonly ImportGroupDraft[],
	previewGroups: readonly ChatImportGroup[],
): ImportGroupDraft[] => {
	const byInitialKey = new Map(
		previewGroups.map((group) => [
			`${group.key}\u0000${group.messagePositions.join(",")}`,
			group,
		]),
	);
	return existing.map((draft) => {
		const initial = byInitialKey.get(
			`${draft.key}\u0000${draft.messages.map((message) => message.position).join(",")}`,
		);
		return initial === undefined
			? draft
			: {
					...draft,
					suggestion:
						initial.suggestion === null
							? null
							: { ...initial.suggestion },
				};
	});
};

const toggleMessageSelection = (
	group: ImportGroupDraft,
	position: number,
	selected: boolean,
): ImportGroupDraft => {
	const present = group.selectedPositions.includes(position);
	if (selected === present) return group;
	return {
		...group,
		selectedPositions: selected
			? [...group.selectedPositions, position]
			: group.selectedPositions.filter((candidate) => candidate !== position),
	};
};

// Merges whole segments into the target Participant. The target keeps its
// identity, name, outcome, suggestion, and approvals; the sources' Messages
// (with their Variant counts and blank-source flags) join the target. The
// previous segments are snapshotted so the merge can be undone.
const mergeSegments = (
	state: ChatImportFlowState,
	targetId: string,
	sourceIds: readonly string[],
): ChatImportFlowState => {
	const target = state.groups.find((group) => group.id === targetId);
	if (target === undefined || sourceIds.length === 0) return state;
	const sources = state.groups.filter(
		(group) => sourceIds.includes(group.id) && group.id !== targetId,
	);
	if (sources.length === 0) return state;

	const merged: ImportGroupDraft = {
		...target,
		messages: [
			...target.messages,
			...sources.flatMap((source) => source.messages),
		],
		selectedPositions: [],
		// Blank-content arriving with merged Messages re-arms the name
		// confirmation when the target had none; an already confirmed
		// blank-affected target keeps its confirmation.
		blankNameConfirmed: target.messages.some((message) => message.isBlankSource)
			? target.blankNameConfirmed
			: !sources.some((source) => hasBlankSource(source)),
	};
	const sourceIdsSet = new Set(sources.map((source) => source.id));
	return {
		...state,
		groups: [
			merged,
			...state.groups.filter((group) => !sourceIdsSet.has(group.id) && group.id !== target.id),
		],
		history: [...state.history, cloneGroups(state.groups)],
	};
};

// Splits selected whole Messages out of one segment. Moving into an existing
// segment keeps that segment's identity and choices; moving into a brand-new
// segment creates a fresh unconfirmed identity that must be named before
// commit. Every Variant stays with its owning Message because the record moves
// as one value.
const splitSegments = (
	state: ChatImportFlowState,
	fromId: string,
	positions: readonly number[],
	to: { existingId: string } | { newId: string; newKey: string; newIsBlank: boolean },
): ChatImportFlowState => {
	const from = state.groups.find((group) => group.id === fromId);
	if (from === undefined || positions.length === 0) return state;

	const moving = new Set(positions);
	const moved = from.messages.filter((message) => moving.has(message.position));
	if (moved.length === 0) return state;
	const keptMessages = from.messages.filter((message) => !moving.has(message.position));

	const kept: ImportGroupDraft = {
		...from,
		messages: keptMessages,
		selectedPositions: [],
	};

	// Moving every Message out of a segment merges that identity away: an
	// emptied source is dropped rather than left to block the review. The
	// pre-split snapshot keeps the operation fully reversible.
	const nextGroups = state.groups
		.map((group) => (group.id === fromId ? kept : group))
		.filter((group) => group.messages.length > 0);

	if ("existingId" in to) {
		const target = nextGroups.find((group) => group.id === to.existingId);
		if (target === undefined || target.id === fromId) return state;
		const nextTarget: ImportGroupDraft = {
			...target,
			messages: [...target.messages, ...moved],
			selectedPositions: [],
			// Blank-content arriving with moved Messages re-arms the name
			// confirmation when the target had none.
			blankNameConfirmed: target.messages.some((message) => message.isBlankSource)
				? target.blankNameConfirmed
				: !moved.some((message) => message.isBlankSource),
		};
		return {
			...state,
			groups: nextGroups.map((group) =>
				group.id === to.existingId ? nextTarget : group,
			),
			history: [...state.history, cloneGroups(state.groups)],
		};
	}

	// A fresh segment starts as an unconfirmed Chat-only identity: it must be
	// named explicitly, and any blank-source Messages it carries require the
	// same confirmation rule as every other blank group.
	const created: ImportGroupDraft = {
		id: to.newId,
		key: to.newKey,
		isBlank: to.newIsBlank,
		messages: moved,
		participantName: "",
		suggestion: null,
		suggestedApproved: true,
		blankNameConfirmed: false,
		outcome: { type: "chat-only" },
		selectedPositions: [],
	};
	return {
		...state,
		groups: [created, ...nextGroups],
		history: [...state.history, cloneGroups(state.groups)],
	};
};

export function reduceChatImportFlow(
	state: ChatImportFlowState,
	action: ChatImportFlowAction,
): ChatImportFlowState {
	switch (action.type) {
		case "begin":
		case "reset":
			return createChatImportFlowState();
		case "file-chosen":
			// The flow accepts exactly one file; only the choose phase may
			// start the single upload.
			return state.phase === "choose"
				? { ...state, phase: "staging", problem: null, cancelPending: false }
				: state;
		case "stage-succeeded": {
			// Only the single in-flight upload may produce a staged preview;
			// stale results arriving after Back/Cancel are ignored.
			if (state.phase !== "staging") return state;
			const { token, preview } = action.stage;
			return {
				...state,
				phase: "preview",
				problem: null,
				cancelPending: false,
				handle: {
					token,
					sha256: preview.sha256,
					originalFilename: preview.originalFilename,
					byteLength: preview.byteLength,
					integrity: preview.integrity,
				},
				title: preview.title,
				counts: { ...preview.counts },
				warnings: [...preview.warnings],
				duplicates: {
					exact: preview.duplicates.exact.map((match) => ({ ...match })),
					related: preview.duplicates.related.map((match) => ({ ...match })),
				},
				duplicateConfirmed: false,
				groups: preview.groups.map(draftFromGroup),
				history: [],
				receipt: null,
			};
		}
		case "stage-failed":
			// Validation completed before any resolution; the reason is
			// contextual and no token was created. Stale failures after the
			// flow moved on are ignored.
			if (state.phase !== "staging") return state;
			return {
				...createChatImportFlowState(),
				problem: action.reason,
			};
		case "preview-succeeded":
			if (!inStagedFlow(state)) return state;
			return {
				...state,
				problem: null,
				counts: { ...action.preview.counts },
				warnings: [...action.preview.warnings],
				duplicates: {
					exact: action.preview.duplicates.exact.map((match) => ({ ...match })),
					related: action.preview.duplicates.related.map((match) => ({
						...match,
					})),
				},
				groups: mergePreviewGroups(state.groups, action.preview.groups),
			};
		case "preview-failed":
			if (!inStagedFlow(state)) return state;
			// Recoverable: the staged token and hash remain valid, so the
			// preview and every choice stay; only the problem is shown.
			return { ...state, problem: action.reason };
		case "title-changed":
			return inStagedFlow(state) ? { ...state, title: action.title } : state;
		case "group-name-changed":
			if (!inStagedFlow(state)) return state;
			return {
				...state,
				groups: state.groups.map((group) =>
					group.id === action.id
						? {
								...group,
								participantName: action.name,
								// Supplying an editable name satisfies the
								// blank-source confirmation rule.
								blankNameConfirmed: hasBlankSource(group)
									? true
									: group.blankNameConfirmed,
							}
						: group,
				),
			};
		case "suggestion-approved":
			if (!inStagedFlow(state)) return state;
			// Approves the currently selected fork Character (the pre-filled
			// suggestion or any Character the user picked from the picker).
			return {
				...state,
				groups: state.groups.map((group) =>
					group.id === action.id && group.outcome.type === "fork"
						? { ...group, suggestedApproved: true }
						: group,
				),
			};
		case "outcome-changed":
			if (!inStagedFlow(state)) return state;
			// Switching outcomes never auto-approves anything: a fork only
			// becomes approved through the explicit approval action.
			return {
				...state,
				groups: state.groups.map((group) =>
					group.id === action.id ? { ...group, outcome: action.outcome } : group,
				),
			};
		case "blank-name-confirmed":
			if (!inStagedFlow(state)) return state;
			return {
				...state,
				groups: state.groups.map((group) =>
					group.id === action.id
						? { ...group, blankNameConfirmed: true }
						: group,
				),
			};
		case "message-selected":
			if (!inStagedFlow(state)) return state;
			return {
				...state,
				groups: state.groups.map((group) =>
					group.id === action.id
						? toggleMessageSelection(
								group,
								action.position,
								action.selected,
							)
						: group,
				),
			};
		case "merge-into":
			if (!inStagedFlow(state)) return state;
			return mergeSegments(state, action.targetId, action.sourceIds);
		case "split-out":
			if (!inStagedFlow(state)) return state;
			return splitSegments(state, action.fromId, action.positions, {
				existingId: action.toId,
			});
		case "split-new":
			if (!inStagedFlow(state)) return state;
			return splitSegments(state, action.fromId, action.positions, {
				newId: action.newId,
				// The fresh segment keeps the source's captured key as its
				// label; the user must still supply an explicit name.
				newKey: state.groups.find((group) => group.id === action.fromId)?.key ?? "",
				newIsBlank:
					state.groups.find((group) => group.id === action.fromId)?.isBlank ??
					false,
			});
		case "undo-resolution":
			if (!inStagedFlow(state) || state.history.length === 0) return state;
			return {
				...state,
				// SAFETY: the history length check above guarantees pop()
				// returns a snapshot.
				groups: cloneGroups(state.history[state.history.length - 1] as ImportGroupDraft[]),
				history: state.history.slice(0, -1),
			};
		case "duplicate-confirmed":
			return inStagedFlow(state)
				? { ...state, duplicateConfirmed: action.confirmed }
				: state;
		case "review-ready":
			return state.phase === "preview"
				? { ...state, phase: "review", problem: null }
				: state;
		case "back-to-preview":
			return state.phase === "review"
				? { ...state, phase: "preview", problem: null }
				: state;
		case "commit-started":
			return state.phase === "review"
				? { ...state, phase: "committing", problem: null }
				: state;
		case "commit-succeeded":
			if (state.phase !== "committing") return state;
			return {
				...state,
				phase: "success",
				problem: null,
				receipt: action.receipt,
			};
		case "commit-failed":
			// Recoverable: the staged preview, the exact bytes, and every
			// resolution choice stay; the review reopens with the reason.
			return state.phase === "committing"
				? { ...state, phase: "review", problem: action.reason }
				: state;
		case "success-dismissed":
			return state.phase === "success"
				? { ...state, phase: "closing" }
				: state;
		case "cancel-requested":
			return { ...state, cancelPending: true };
		case "cancel-abandoned":
			return { ...state, cancelPending: false };
		case "confirm-cancel":
			// Closing phase: the view discards the staged handle (when one
			// exists) and closes the nested flow.
			return { ...state, cancelPending: false, phase: "closing" };
		case "back-to-choose":
			if (state.phase !== "preview" && state.phase !== "review") return state;
			return {
				...createChatImportFlowState(),
				problem: state.problem,
			};
	}
}

// Cancel warns only when an open flow could be discarded: a file is being
// uploaded or a staged preview/resolution/review exists. Choosing phase
// closes without a warning because nothing has been staged yet; the success
// and closing phases hold a committed Chat, never uncommitted staging data.
export const cancelNeedsWarning = (state: ChatImportFlowState): boolean =>
	state.phase === "staging" ||
	state.phase === "preview" ||
	state.phase === "review";

// The single-upload gate: only the choose phase may start an upload, so a
// double invocation (or a retry after a recoverable error) can never stream
// the file a second time.
export const shouldBeginUpload = (state: ChatImportFlowState): boolean =>
	state.phase === "choose";

// Includes a wasted segment check: a Participant owning no Messages must be
// split back or merged away before commit. Position coverage itself is
// validated authoritatively by the server at commit; this gate only keeps
// the obvious structural errors and unresolved choices out of the review.
export const resolutionReady = (state: ChatImportFlowState): boolean => {
	if (state.title.trim() === "") return false;
	return state.groups.every((group) => {
		if (group.messages.length === 0) return false;
		if (group.participantName.trim() === "") return false;
		if (group.outcome.type === "fork" && !group.suggestedApproved) return false;
		if (hasBlankSource(group) && !group.blankNameConfirmed) return false;
		return true;
	});
};

// The review may proceed to commit only when every resolution choice is
// confirmed and an exact duplicate has received its explicit Import another
// copy confirmation.
export const canCommit = (state: ChatImportFlowState): boolean =>
	resolutionReady(state) &&
	(state.duplicates.exact.length === 0 || state.duplicateConfirmed);

// Derived duplicate-name warnings: new-Character Participants may reuse a
// name already held by an existing Profile or by another resolved
// Participant; uniqueness is never enforced, so the warning is the visible
// acknowledgement while the authoritative commit always succeeds.
export const deriveDuplicateNameWarnings = (
	state: ChatImportFlowState,
	characters: readonly { id: number; name: string }[],
): string[] => {
	const warnings: string[] = [];
	const existingNames = new Set(
		characters.map((character) => character.name.toLocaleLowerCase()),
	);
	const seen = new Set<string>();
	for (const group of state.groups) {
		if (group.outcome.type !== "new-character") continue;
		const name = group.participantName.trim();
		if (name === "") continue;
		const lowered = name.toLocaleLowerCase();
		if (existingNames.has(lowered)) {
			warnings.push(
				`A Character named "${name}" already exists; this import creates a new independent Character with the same name.`,
			);
		}
		if (seen.has(lowered)) {
			warnings.push(
				`More than one resolved Participant is named "${name}"; duplicate Participant names remain valid.`,
			);
		}
		seen.add(lowered);
	}
	return warnings;
};

// The commit payload built from the confirmed resolution, ready for the
// replaceable import client.
export const buildResolvedParticipants = (
	state: ChatImportFlowState,
): { name: string; outcome: ImportResolutionOutcome; messagePositions: number[] }[] =>
	state.groups.map((group) => ({
		name: group.participantName,
		outcome: group.outcome,
		messagePositions: group.messages.map((message) => message.position),
	}));
