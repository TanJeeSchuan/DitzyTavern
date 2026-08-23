// Pure state transitions for the Import Chat flow. The view orchestrates
// the replaceable import client and feeds typed outcomes back into this
// reducer, so every step (choose, upload-once staging, staged preview,
// recoverable-error refresh, cancel warning, discard) is testable without a
// browser or a frontend framework. No browser File reference ever lives in
// the state: after the initial upload the flow works from the staged token
// and SHA-256 alone.

import type {
	ChatImportDuplicateMatch,
	ChatImportGroup,
	ChatImportPreview,
	ChatImportSuggestion,
} from "./import-chat";

// The editable Participant-name default for blank captured author groups,
// mirroring the server seam's constant so the UI label never drifts.
export const UNKNOWN_IMPORTED_AUTHOR_NAME = "Unknown imported author";

export type ChatImportPhase = "choose" | "staging" | "preview" | "closing";

// The user-editable working copy of one preview group: the exact captured
// author string (`key`) stays fixed, the Participant name is editable, and
// the pre-filled Character suggestion stays visibly unconfirmed until the
// user approves it.
export interface ImportGroupDraft {
	key: string;
	isBlank: boolean;
	messagePositions: number[];
	messageCount: number;
	variantCount: number;
	participantName: string;
	suggestion: ChatImportSuggestion | null;
	confirmed: boolean;
}

export interface ChatImportFlowState {
	phase: ChatImportPhase;
	// True while the Cancel warning is shown before discarding the flow.
	cancelPending: boolean;
	// Contextual problem text; recoverable errors keep the staged preview
	// and every choice made during this flow.
	problem: string | null;
	// The staged handle and its binding. Both are required for any preview
	// refresh; neither is ever reconstructed from a browser path.
	token: string | null;
	sha256: string | null;
	filename: string | null;
	byteLength: number | null;
	integrity: string | null;
	title: string;
	counts: { messages: number; variants: number } | null;
	warnings: string[];
	duplicates: {
		exact: ChatImportDuplicateMatch[];
		related: ChatImportDuplicateMatch[];
	};
	groups: ImportGroupDraft[];
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
	| { type: "group-name-changed"; key: string; name: string }
	| { type: "suggestion-confirmed"; key: string }
	| { type: "cancel-requested" }
	| { type: "cancel-abandoned" }
	| { type: "confirm-cancel" }
	// Back from the staged preview to file selection; the view discards the
	// old token before dispatching this.
	| { type: "back-to-choose" }
	| { type: "reset" };

export const createChatImportFlowState = (): ChatImportFlowState => ({
	phase: "choose",
	cancelPending: false,
	problem: null,
	token: null,
	sha256: null,
	filename: null,
	byteLength: null,
	integrity: null,
	title: "",
	counts: null,
	warnings: [],
	duplicates: { exact: [], related: [] },
	groups: [],
});

const draftFromGroup = (group: ChatImportGroup): ImportGroupDraft => ({
	key: group.key,
	isBlank: group.isBlank,
	messagePositions: [...group.messagePositions],
	messageCount: group.messageCount,
	variantCount: group.variantCount,
	participantName: group.participantNameDefault,
	suggestion: group.suggestion === null ? null : { ...group.suggestion },
	confirmed: false,
});

// Merges a refreshed preview into the working drafts: preview-derived
// fields update, while the user's editable Participant names and approvals
// survive by exact group key. New groups (never expected for the same
// bound bytes, but possible after server-side library changes) start as
// fresh unconfirmed drafts.
const mergePreviewGroups = (
	existing: readonly ImportGroupDraft[],
	previewGroups: readonly ChatImportGroup[],
): ImportGroupDraft[] => {
	const byKey = new Map(existing.map((draft) => [draft.key, draft]));
	return previewGroups.map((group) => {
		const draft = draftFromGroup(group);
		const current = byKey.get(group.key);
		if (current !== undefined) {
			draft.participantName = current.participantName;
			draft.confirmed = current.confirmed;
		}
		return draft;
	});
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
				token,
				sha256: preview.sha256,
				filename: preview.originalFilename,
				byteLength: preview.byteLength,
				integrity: preview.integrity,
				title: preview.title,
				counts: { ...preview.counts },
				warnings: [...preview.warnings],
				duplicates: {
					exact: preview.duplicates.exact.map((match) => ({ ...match })),
					related: preview.duplicates.related.map((match) => ({ ...match })),
				},
				groups: preview.groups.map(draftFromGroup),
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
			if (state.phase !== "preview") return state;
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
			if (state.phase !== "preview") return state;
			// Recoverable: the staged token and hash remain valid, so the
			// preview and every choice stay; only the problem is shown.
			return { ...state, problem: action.reason };
		case "title-changed":
			return state.phase === "preview"
				? { ...state, title: action.title }
				: state;
		case "group-name-changed":
			if (state.phase !== "preview") return state;
			return {
				...state,
				groups: state.groups.map((group) =>
					group.key === action.key
						? { ...group, participantName: action.name }
						: group,
				),
			};
		case "suggestion-confirmed":
			if (state.phase !== "preview") return state;
			return {
				...state,
				groups: state.groups.map((group) =>
					group.key === action.key && group.suggestion !== null
						? { ...group, confirmed: true }
						: group,
				),
			};
		case "cancel-requested":
			return { ...state, cancelPending: true };
		case "cancel-abandoned":
			return { ...state, cancelPending: false };
		case "confirm-cancel":
			// Closing phase: the view discards the staged handle (when one
			// exists) and closes the nested flow.
			return { ...state, cancelPending: false, phase: "closing" };
		case "back-to-choose":
			if (state.phase !== "preview") return state;
			return {
				...createChatImportFlowState(),
				problem: state.problem,
			};
	}
}

// Cancel warns only when an open flow could be discarded: a file is being
// uploaded or a staged preview exists. Choosing phase closes without a
// warning because nothing has been staged yet.
export const cancelNeedsWarning = (state: ChatImportFlowState): boolean =>
	state.phase === "staging" || state.phase === "preview";

// The single-upload gate: only the choose phase may start an upload, so a
// double invocation (or a retry after a recoverable preview error) can
// never stream the file a second time.
export const shouldBeginUpload = (state: ChatImportFlowState): boolean =>
	state.phase === "choose";

// Final-review gate used to make the pre-filled suggestion visible and
// required: every group with a suggested Character must be explicitly
// approved before an import may proceed.
export const allSuggestionsConfirmed = (state: ChatImportFlowState): boolean =>
	state.groups.every((group) => group.suggestion === null || group.confirmed);