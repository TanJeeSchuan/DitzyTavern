import type {
	ConversationPromptPreset,
	PromptOutgoingRole,
	PromptPresetBlockPatch,
	PromptPresetSummary,
	ResolvedPromptPresetSlot,
	SillyTavernImportPreview,
	SillyTavernImportRequest,
	SillyTavernJsonValue,
} from "../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== The Prompt Preset popup's decision rules, separated from its rendering and
// its transport: which read or mutation response may still apply, how saved
// drafts reconcile and retire against the authoritative recipe, and how busy,
// notice and leave state transition. The controller hook and the dialog stay
// thin wiring over these pure transitions.

export type BlockDraft =
	| { kind: "role"; role: PromptOutgoingRole }
	| { kind: "content"; name: string; content: string; role: PromptOutgoingRole };

// ==[HUMAN APPROVED]== One slot-kind-safe draft-to-patch rule. A referenced Definition slot
// accepts only role drafts, an authored instruction accepts only name/text/role drafts, and
// history accepts none. The rule returns the exact occurrence-addressed patch a dirty draft
// submits, or null when the draft is clean, the wrong kind for its slot, or the slot accepts
// no drafts — so dirtiness, per-block Save, batch building and submitted-version retirement
// all flow from one source and the silent-clean and wrong-field Save paths cannot exist.
export function draftToPatch(
	slot: ResolvedPromptPresetSlot,
	draft: BlockDraft,
): PromptPresetBlockPatch | null {
	if (slot.reference === "history") return null;
	if (slot.reference === "instruction") {
		if (draft.kind !== "content") return null;
		const { name, content, role } = draft;
		if (name === slot.name && content === slot.content && role === slot.role) return null;
		return { occurrenceId: slot.id, type: "content", name, content, role };
	}
	if (draft.kind !== "role") return null;
	if (draft.role === slot.role) return null;
	return { occurrenceId: slot.id, type: "role", role: draft.role };
}

export const draftIsDirty = (slot: ResolvedPromptPresetSlot, draft: BlockDraft): boolean =>
	draftToPatch(slot, draft) !== null;

// ==[HUMAN APPROVED]== The one-pass dirty summary: `dirty` is the guard every dismissal path
// consults and `count` is what the unsaved-drafts dialog shows, both from one scan.
interface DirtyDraftSummary {
	dirty: boolean;
	count: number;
}

export function dirtyDraftSummary(
	preset: ConversationPromptPreset,
	drafts: Record<number, BlockDraft>,
): DirtyDraftSummary {
	let count = 0;
	for (const slot of preset.slots) {
		const draft = drafts[slot.id];
		if (draft !== undefined && draftToPatch(slot, draft) !== null) count += 1;
	}
	return { dirty: count > 0, count };
}

// ==[HUMAN APPROVED]== A save finishes exactly the submitted draft version: after a successful
// save the editor retires an occurrence's draft only when it still equals
// what was submitted, so a newer local edit made while saving survives.
const blockDraftEquals = (a: BlockDraft, b: BlockDraft): boolean => {
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
		const patch = draft === undefined ? null : draftToPatch(slot, draft);
		if (patch === null) continue;
		patches.push(patch);
		submitted[slot.id] = draft;
	}
	return { patches, submitted };
}

export type PresetView =
	| { status: "loading" }
	| { status: "ready"; presets: PromptPresetSummary[]; selected: ConversationPromptPreset }
	| { status: "unavailable" };

export type LeaveRequest = { kind: "close" } | { kind: "select"; presetId: number };

// ==[HUMAN APPROVED]== The SillyTavern import review is transient editor state: opening, closing
// or switching Chat clears it through the same session transition as every
// other form, so no dismissal path can strand a review.
export interface SillyTavernReview {
	request: SillyTavernImportRequest & { source: SillyTavernJsonValue };
	preview: SillyTavernImportPreview;
	orderListId: string | null;
}

export type EditorLoadResult = "ready" | "not-found" | "network" | "stale";

// ==[HUMAN APPROVED]== The editor session owns the response ordering: `id` changes when the popup
// opens, closes or switches Chat, `latestRead` when a newer read supersedes
// an older one, and `latestOperation`/`latestConversationOperation` when a
// newer mutation supersedes an older one. A response may apply only while
// every epoch it was claimed under is still current.
interface EditorSession {
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
	// ==[HUMAN APPROVED]== `busy` holds the popup against a second operation. The deferred
	// save-on-leave needs no flag: the leave resolves only after the save operation settles,
	// so the next selection starts with busy already released.
	busy: boolean;
	notice: string | null;
	problem: string | null;
	leaveRequest: LeaveRequest | null;
	review: SillyTavernReview | null;
}

// ==[HUMAN APPROVED]== The start effects one operation declares at the call site where the flow
// starts: whether it supersedes the in-flight read, whether it owns the Conversation race, and
// which feedback channels it clears. There is no global operation registry or policy table —
// every flow states its own effects, so clearing either or both feedback channels needs no new
// closed enum, and the leave handoff needs no state flag because it is the hook's
// settle-then-resolve sequencing.
export interface OperationStartEffects {
	supersedesReads: boolean;
	ownsConversation: boolean;
	clearNotice: boolean;
	clearProblem: boolean;
}

export type PromptPresetEditorEvent =
	| { type: "session-changed"; sessionKey: string; conversationRevision: number | null }
	| { type: "conversation-revision-changed"; conversationRevision: number | null }
	| { type: "conversation-adopted"; conversationRevision: number }
	| { type: "read-started" }
	| { type: "operation-started"; effects: OperationStartEffects }
	| { type: "operation-settled"; claim: OperationClaim }
	| { type: "notice-changed"; notice: string | null }
	| { type: "problem-changed"; problem: string | null }
	| { type: "draft-changed"; blockId: number; draft: BlockDraft }
	| { type: "draft-cleared"; blockId: number }
	| { type: "recipe-adopted"; claim: ReadClaim; selected: ConversationPromptPreset; presets?: PromptPresetSummary[] }
	| { type: "recipe-unavailable" }
	| { type: "load-failed" }
	| { type: "drafts-submitted"; submitted: Record<number, BlockDraft> }
	| { type: "review-changed"; review: SillyTavernReview | null }
	| { type: "leave-requested"; request: LeaveRequest }
	| { type: "leave-kept" }
	| { type: "leave-resolved" }
	| { type: "leave-failed"; problem: string };

// ==[HUMAN APPROVED]== One clean session and one clean editor state, shared by construction and by
// every open, close or Chat transition, so the two can never drift.
function cleanSession(key: string, id: number, conversationRevision: number | null): EditorSession {
	return {
		key,
		id,
		latestRead: 0,
		latestOperation: 0,
		latestConversationOperation: 0,
		knownRevision: conversationRevision,
		draftPresetId: null,
		pendingRetire: null,
	};
}

function cleanEditorState(session: EditorSession): PromptPresetEditorState {
	return {
		session,
		view: { status: "loading" },
		drafts: {},
		busy: false,
		notice: null,
		problem: null,
		leaveRequest: null,
		review: null,
	};
}

export function createPromptPresetEditorState(
	sessionKey: string,
	conversationRevision: number | null,
): PromptPresetEditorState {
	return cleanEditorState(cleanSession(sessionKey, 1, conversationRevision));
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

// ==[HUMAN APPROVED]== Whether a fresh recipe slot reflects what a submitted draft saved. A role
// draft is reflected by the matching referenced slot role; a content draft by the matching
// authored instruction name, text and role. A read that predates a save never reflects the
// submitted version, so it cannot retire it against an older recipe.
function slotReflectsSubmitted(slot: ResolvedPromptPresetSlot, submitted: BlockDraft): boolean {
	if (submitted.kind === "role") {
		return slot.reference !== "history" && slot.reference !== "instruction" && slot.role === submitted.role;
	}
	return slot.reference === "instruction"
		&& slot.name === submitted.name
		&& slot.content === submitted.content
		&& slot.role === submitted.role;
}

// ==[HUMAN APPROVED]== One selected-recipe acceptance rule: the fresh recipe replaces the view and
// the drafts reconcile against it in one pass. Switching presets clears the draft set scoped to
// the old preset; a reload prunes drafts for occurrences the recipe no longer contains and
// retires exactly the submitted versions a successful save wrote — only when the fresh recipe
// reflects them and the current draft still equals what was submitted, never a newer local edit.
function adoptRecipe(
	state: PromptPresetEditorState,
	selected: ConversationPromptPreset,
	presets: PromptPresetSummary[] | undefined,
): PromptPresetEditorState {
	let session = state.session;
	let drafts: Record<number, BlockDraft>;
	if (state.session.draftPresetId !== selected.id) {
		session = { ...session, draftPresetId: selected.id, pendingRetire: null };
		drafts = {};
	} else {
		const retire = session.pendingRetire;
		session = { ...session, pendingRetire: null };
		const byId = new Map(selected.slots.map((slot) => [slot.id, slot]));
		drafts = {};
		for (const key of Object.keys(state.drafts)) {
			const blockId = Number(key);
			const slot = byId.get(blockId);
			if (slot === undefined) continue;
			const draft = state.drafts[blockId];
			const submitted = retire?.[blockId];
			if (
				submitted !== undefined
				&& slotReflectsSubmitted(slot, submitted)
				&& blockDraftEquals(submitted, draft)
			) {
				continue;
			}
			drafts[blockId] = draft;
		}
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
			return cleanEditorState(
				cleanSession(event.sessionKey, state.session.id + 1, event.conversationRevision),
			);
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
					latestRead: state.session.latestRead + (event.effects.supersedesReads ? 1 : 0),
					latestConversationOperation: state.session.latestConversationOperation +
						(event.effects.ownsConversation ? 1 : 0),
				},
				busy: true,
				notice: event.effects.clearNotice ? null : state.notice,
				problem: event.effects.clearProblem ? null : state.problem,
			};
		case "operation-settled":
			return operationApplies(state, event.claim) ? { ...state, busy: false } : state;
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
					// ==[HUMAN APPROVED]== Merge pending retirement explicitly: each submitted
					// occurrence's version joins (or replaces) the pending set, with the null case
					// stated rather than relying on spreading a nullable map.
					pendingRetire: state.session.pendingRetire === null
						? { ...event.submitted }
						: { ...state.session.pendingRetire, ...event.submitted },
				},
			};
		case "review-changed":
			return { ...state, review: event.review };
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
