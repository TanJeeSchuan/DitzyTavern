import type {
	ConversationPromptPreset,
	PromptOutgoingRole,
	PromptPresetBlockPatch,
	PromptPresetSummary,
	ResolvedPromptPresetSlot,
} from "../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== The Prompt Preset popup's decision rules, separated from its rendering and
// its transport: which read or mutation response may still apply, how saved
// drafts reconcile and retire against the authoritative recipe, and how busy,
// notice and leave state transition. The controller hook and the dialog stay
// thin wiring over these pure transitions.

export type BlockDraft =
	| { kind: "role"; role: PromptOutgoingRole }
	| { kind: "content"; name: string; content: string; role: PromptOutgoingRole };

export const draftIsDirty = (slot: ResolvedPromptPresetSlot, draft: BlockDraft): boolean => {
	if (slot.reference === "instruction") {
		return draft.kind !== "content"
			? true
			: draft.name !== slot.name || draft.content !== slot.content || draft.role !== slot.role;
	}
	return slot.reference !== "history" && draft.kind === "role" && draft.role !== slot.role;
};

export const dirtyDraftCount = (
	preset: ConversationPromptPreset,
	drafts: Record<number, BlockDraft>,
): number => preset.slots.filter((slot) => {
	const draft = drafts[slot.id];
	return draft !== undefined && draftIsDirty(slot, draft);
}).length;

// ==[HUMAN APPROVED]== A save finishes exactly the submitted draft version: after a successful
// save the editor retires an occurrence's draft only when it still equals
// what was submitted, so a newer local edit made while saving survives.
export const blockDraftEquals = (a: BlockDraft, b: BlockDraft): boolean => {
	if (a.kind === "role") return b.kind === "role" && a.role === b.role;
	return b.kind === "content" && a.name === b.name && a.content === b.content && a.role === b.role;
};

export interface DirtyBlockPatches {
	patches: PromptPresetBlockPatch[];
	submitted: Record<number, BlockDraft>;
}

// ==[HUMAN APPROVED]== Save-on-leave submits every dirty occurrence in one typed domain command.
// The patches address occurrences, and the submitted map carries the exact
// versions that may be retired once a fresh recipe is accepted.
export function dirtyBlockPatches(
	preset: ConversationPromptPreset,
	drafts: Record<number, BlockDraft>,
): DirtyBlockPatches {
	const patches: PromptPresetBlockPatch[] = [];
	const submitted: Record<number, BlockDraft> = {};
	for (const slot of preset.slots) {
		const draft = drafts[slot.id];
		if (draft === undefined || !draftIsDirty(slot, draft)) continue;
		if (slot.reference === "instruction" && draft.kind === "content") {
			patches.push({
				occurrenceId: slot.id,
				type: "content",
				name: draft.name,
				content: draft.content,
				role: draft.role,
			});
			submitted[slot.id] = { kind: "content", name: draft.name, content: draft.content, role: draft.role };
		} else if (slot.reference !== "history" && draft.kind === "role") {
			patches.push({ occurrenceId: slot.id, type: "role", role: draft.role });
			submitted[slot.id] = { kind: "role", role: draft.role };
		}
	}
	return { patches, submitted };
}

export type PresetView =
	| { status: "loading" }
	| { status: "ready"; presets: PromptPresetSummary[]; selected: ConversationPromptPreset }
	| { status: "unavailable" };

export type LeaveRequest = { kind: "close" } | { kind: "select"; presetId: number };

export type EditorOperation = "busy" | "leave";

export type EditorLoadResult = "ready" | "not-found" | "network" | "stale";

// ==[HUMAN APPROVED]== The editor session owns the response ordering: `id` changes when the popup
// opens, closes or switches Chat, `latestRead` when a newer read supersedes
// an older one, and `latestOperation`/`latestConversationOperation` when a
// newer mutation supersedes an older one. A response may apply only while
// every epoch it was claimed under is still current.
export interface EditorSession {
	key: string;
	id: number;
	latestRead: number;
	latestOperation: number;
	latestConversationOperation: number;
	knownRevision: number | null;
	draftPresetId: number | null;
	pendingRetire: Record<number, BlockDraft> | null;
}

export interface ReadClaim {
	sessionId: number;
	readId: number;
}

export interface OperationClaim {
	sessionId: number;
	operationId: number;
}

export interface ConversationOperationClaim extends OperationClaim {
	conversationOperationId: number;
}

export interface PromptPresetEditorState {
	session: EditorSession;
	view: PresetView;
	drafts: Record<number, BlockDraft>;
	operation: EditorOperation | null;
	notice: string | null;
	problem: string | null;
	leaveRequest: LeaveRequest | null;
}

export type PromptPresetEditorEvent =
	| { type: "session-changed"; sessionKey: string; conversationRevision: number | null }
	| { type: "conversation-revision-changed"; conversationRevision: number | null }
	| { type: "conversation-adopted"; conversationRevision: number }
	| { type: "read-started" }
	| {
			type: "operation-started";
			operation: EditorOperation;
			invalidateReads?: boolean;
			conversationOperation?: boolean;
			clearNotice?: boolean;
			clearProblem?: boolean;
	  }
	| { type: "operation-settled"; claim: OperationClaim }
	| { type: "notice-changed"; notice: string | null }
	| { type: "problem-changed"; problem: string | null }
	| { type: "draft-changed"; blockId: number; draft: BlockDraft }
	| { type: "draft-cleared"; blockId: number }
	| { type: "recipe-adopted"; claim: ReadClaim; selected: ConversationPromptPreset; presets?: PromptPresetSummary[] }
	| { type: "recipe-unavailable" }
	| { type: "load-failed" }
	| { type: "drafts-submitted"; submitted: Record<number, BlockDraft> }
	| { type: "leave-requested"; request: LeaveRequest }
	| { type: "leave-kept" }
	| { type: "leave-resolved" }
	| { type: "leave-failed"; problem: string };

export function createPromptPresetEditorState(
	sessionKey: string,
	conversationRevision: number | null,
): PromptPresetEditorState {
	return {
		session: {
			key: sessionKey,
			id: 1,
			latestRead: 0,
			latestOperation: 0,
			latestConversationOperation: 0,
			knownRevision: conversationRevision,
			draftPresetId: null,
			pendingRetire: null,
		},
		view: { status: "loading" },
		drafts: {},
		operation: null,
		notice: null,
		problem: null,
		leaveRequest: null,
	};
}

export const readClaim = (state: PromptPresetEditorState): ReadClaim => ({
	sessionId: state.session.id,
	readId: state.session.latestRead,
});

export const operationClaim = (state: PromptPresetEditorState): OperationClaim => ({
	sessionId: state.session.id,
	operationId: state.session.latestOperation,
});

export const conversationOperationClaim = (
	state: PromptPresetEditorState,
): ConversationOperationClaim => ({
	...operationClaim(state),
	conversationOperationId: state.session.latestConversationOperation,
});

export const readApplies = (state: PromptPresetEditorState, claim: ReadClaim): boolean =>
	state.session.id === claim.sessionId && claim.readId === state.session.latestRead;

export const operationApplies = (
	state: PromptPresetEditorState,
	claim: OperationClaim,
): boolean =>
	state.session.id === claim.sessionId && claim.operationId === state.session.latestOperation;

export const conversationOperationApplies = (
	state: PromptPresetEditorState,
	claim: ConversationOperationClaim,
): boolean =>
	operationApplies(state, claim) &&
	claim.conversationOperationId === state.session.latestConversationOperation;

// ==[HUMAN APPROVED]== One selected-recipe acceptance rule: the fresh recipe replaces the view and
// the drafts reconcile against it. Switching presets clears the draft set, a
// reload prunes drafts for occurrences the recipe no longer contains, and
// drafts a successful save submitted retire once accepted — but only the
// submitted version, never a newer local edit.
function adoptRecipe(
	state: PromptPresetEditorState,
	selected: ConversationPromptPreset,
	presets: PromptPresetSummary[] | undefined,
): PromptPresetEditorState {
	let session = state.session;
	let drafts = state.drafts;
	if (state.session.draftPresetId !== selected.id) {
		session = { ...session, draftPresetId: selected.id, pendingRetire: null };
		drafts = {};
	} else {
		const retire = session.pendingRetire;
		session = { ...session, pendingRetire: null };
		const alive = new Set(selected.slots.map((slot) => slot.id));
		let kept = drafts;
		if (retire !== null) {
			for (const key of Object.keys(drafts)) {
				const blockId = Number(key);
				const submitted = retire[blockId];
				if (submitted !== undefined && blockDraftEquals(submitted, drafts[blockId])) {
					kept = { ...kept };
					delete kept[blockId];
				}
			}
		}
		drafts = Object.fromEntries(
			Object.entries(kept).filter(([draftId]) => alive.has(Number(draftId))),
		);
	}
	return {
		...state,
		session,
		drafts,
		view: {
			status: "ready",
			presets: presets ?? (state.view.status === "ready" ? state.view.presets : []),
			selected,
		},
	};
}

export function reducePromptPresetEditorState(
	state: PromptPresetEditorState,
	event: PromptPresetEditorEvent,
): PromptPresetEditorState {
	switch (event.type) {
		case "session-changed":
			// ==[HUMAN APPROVED]== Every open or Chat transition starts clean: transient forms,
			// notices, drafts and pending leaves belong to one popup session.
			return {
				session: {
					key: event.sessionKey,
					id: state.session.id + 1,
					latestRead: 0,
					latestOperation: 0,
					latestConversationOperation: 0,
					knownRevision: event.conversationRevision,
					draftPresetId: null,
					pendingRetire: null,
				},
				view: { status: "loading" },
				drafts: {},
				operation: null,
				notice: null,
				problem: null,
				leaveRequest: null,
			};
		case "conversation-revision-changed":
			// ==[HUMAN APPROVED]== A newer Conversation snapshot invalidates pending responses but
			// its refresh is unrelated to the block drafts owned by this session.
			return {
				...state,
				session: {
					...state.session,
					knownRevision: event.conversationRevision,
					latestRead: state.session.latestRead + 1,
					latestConversationOperation: state.session.latestConversationOperation + 1,
				},
			};
		case "conversation-adopted":
			return {
				...state,
				session: { ...state.session, knownRevision: event.conversationRevision },
			};
		case "read-started":
			return { ...state, session: { ...state.session, latestRead: state.session.latestRead + 1 } };
		case "operation-started":
			return {
				...state,
				session: {
					...state.session,
					latestOperation: state.session.latestOperation + 1,
					latestRead: state.session.latestRead + (event.invalidateReads === true ? 1 : 0),
					latestConversationOperation: state.session.latestConversationOperation +
						(event.conversationOperation === true ? 1 : 0),
				},
				operation: event.operation,
				notice: event.clearNotice === true ? null : state.notice,
				problem: event.clearProblem === true ? null : state.problem,
			};
		case "operation-settled":
			return operationApplies(state, event.claim) ? { ...state, operation: null } : state;
		case "notice-changed":
			return { ...state, notice: event.notice };
		case "problem-changed":
			return { ...state, problem: event.problem };
		case "draft-changed":
			return { ...state, drafts: { ...state.drafts, [event.blockId]: event.draft } };
		case "draft-cleared":
			return {
				...state,
				drafts: Object.fromEntries(
					Object.entries(state.drafts).filter(([draftId]) => Number(draftId) !== event.blockId),
				),
			};
		case "recipe-adopted":
			return readApplies(state, event.claim)
				? adoptRecipe(state, event.selected, event.presets)
				: state;
		case "recipe-unavailable":
			return {
				...state,
				session: { ...state.session, draftPresetId: null, pendingRetire: null },
				drafts: {},
				view: { status: "unavailable" },
			};
		case "load-failed":
			return state.view.status === "ready" ? state : { ...state, view: { status: "unavailable" } };
		case "drafts-submitted":
			return {
				...state,
				session: {
					...state.session,
					pendingRetire: { ...state.session.pendingRetire, ...event.submitted },
				},
			};
		case "leave-requested":
			return { ...state, leaveRequest: event.request };
		case "leave-kept":
			return { ...state, leaveRequest: null };
		case "leave-resolved":
			// ==[HUMAN APPROVED]== Completing a resolved leave drops the drafts and the pending
			// retirement; the deferred close or selection runs after this transition.
			return {
				...state,
				session: { ...state.session, pendingRetire: null },
				drafts: {},
				leaveRequest: null,
			};
		case "leave-failed":
			return { ...state, problem: event.problem, leaveRequest: null };
	}
}
