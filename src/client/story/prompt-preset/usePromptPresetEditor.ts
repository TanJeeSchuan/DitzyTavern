import { useRef, useState } from "react";
import {
	applyConversationCommand,
	loadConversationPromptPreset,
	type ConversationPromptPreset,
	type ConversationSummary,
	type PromptPresetOperationOutcome,
} from "../../conversation";
import { runConversationCommand } from "../../conversation-command-runner";
import {
	applyPromptPresetCommand,
	commitSillyTavernPromptPreset,
	importNativePromptPreset,
	loadNativePromptPreset,
	listPromptPresets,
	parseNativePromptPreset,
	reviewSillyTavernPromptPreset,
	savePromptPresetBlockPatches,
	type PresetCommandOutcome,
	type PromptPresetCommand,
	type SillyTavernJsonValue,
} from "../../prompt-preset-library";
import { LIBRARY_UNREACHABLE_NOTICE } from "../../lib/command-outcome";
import { presetDeletionImpactChangedNotice } from "../../prompt-preset-presentation";
import { useAsyncEffect } from "../../lib/use-async";
import {
	conversationOperationApplies,
	conversationOperationClaim,
	createPromptPresetEditorState,
	dirtyBlockPatches,
	dirtyDraftCount,
	draftIsDirty,
	operationApplies,
	operationClaim,
	readApplies,
	readClaim,
	reducePromptPresetEditorState,
	type BlockDraft,
	type ConversationOperationClaim,
	type EditorLoadResult,
	type LeaveRequest,
	type OperationClaim,
	type PromptPresetEditorEvent,
	type ReadClaim,
} from "../../prompt-preset-editor-state";
import type { SillyTavernReview } from "./PromptPresetImportReviewDialog";

const PRESET_COMMAND_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation no longer exists.",
	unreachable: "The Conversation could not be reached.",
};

/**
 * ==[HUMAN APPROVED]== Owns the Prompt Preset popup's async work: loading, library commands, preset
 * selection, import and export, and recipe operations. Every flow claims one
 * session-owned epoch once and consults the pure editor state's applicability
 * rules afterwards, so response ordering lives in one place instead of in
 * every handler. Effect cancellation still belongs to `useAsyncEffect`, and
 * the rendered busy state stays rendered state.
 */
export function usePromptPresetEditor({
	conversation,
	open,
	onConversationChange,
	onOpenChange,
}: {
	conversation: ConversationSummary | null;
	open: boolean;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	onOpenChange: (open: boolean) => void;
}) {
	const sessionKey = open ? `open:${conversation?.id ?? "none"}` : "closed";
	const [state, setState] = useState(() =>
		createPromptPresetEditorState(sessionKey, conversation?.revision ?? null));
	const stateRef = useRef(state);
	const [review, setReview] = useState<SillyTavernReview | null>(null);

	const dispatch = (event: PromptPresetEditorEvent): void => {
		const next = reducePromptPresetEditorState(stateRef.current, event);
		stateRef.current = next;
		setState(next);
	};

	// ==[HUMAN APPROVED]== The one ownership check every flow consults after an await: a response
	// may still apply only while the session and epoch it was claimed under are
	// current. Response ordering lives here, not in each handler.
	const ownsRead = (claim: ReadClaim): boolean => readApplies(stateRef.current, claim);
	const ownsOperation = (claim: OperationClaim): boolean => operationApplies(stateRef.current, claim);
	const ownsConversationOperation = (claim: ConversationOperationClaim): boolean =>
		conversationOperationApplies(stateRef.current, claim);

	// ==[HUMAN APPROVED]== One settle and one refresh-failure report, shared by every flow, so the
	// ownership check and the established notices cannot drift between handlers.
	const settleOperation = (claim: OperationClaim): void => {
		if (ownsOperation(claim)) dispatch({ type: "operation-settled", claim });
	};
	const reportRefreshFailure = (refresh: EditorLoadResult): boolean => {
		if (refresh === "network") {
			dispatch({ type: "notice-changed", notice: LIBRARY_UNREACHABLE_NOTICE });
			return true;
		}
		if (refresh === "not-found") {
			dispatch({ type: "notice-changed", notice: "The selected Conversation could not be loaded." });
			return true;
		}
		return false;
	};
	const reportImportFailure = (
		outcome: { status: "invalid"; reason: string } | { status: "network" },
	): void => {
		dispatch({
			type: "notice-changed",
			notice: outcome.status === "invalid" ? outcome.reason : LIBRARY_UNREACHABLE_NOTICE,
		});
	};
	// ==[HUMAN APPROVED]== The shared import epilogue: reload the library and the selected recipe,
	// then report the imported name once the fresh state is accepted.
	const reloadAfterImport = async (claim: OperationClaim, notice: string): Promise<void> => {
		const refresh = await load();
		if (!ownsOperation(claim)) return;
		if (reportRefreshFailure(refresh)) return;
		dispatch({ type: "notice-changed", notice });
	};

	const { view, drafts, busy, leaving, notice, problem, leaveRequest } = state;
	const ready = view.status === "ready" ? view : null;
	const dirty = ready !== null && ready.selected.slots.some((slot) => {
		const draft = drafts[slot.id];
		return draft !== undefined && draftIsDirty(slot, draft);
	});
	const dirtyCount = ready === null ? 0 : dirtyDraftCount(ready.selected, drafts);

	const load = async (isCancelled?: () => boolean): Promise<EditorLoadResult> => {
		if (!open) return "stale";
		if (conversation === null) {
			dispatch({ type: "recipe-unavailable" });
			return "not-found";
		}
		const conversationId = conversation.id;
		dispatch({ type: "read-started" });
		const claim = readClaim(stateRef.current);
		try {
			const [presets, selected] = await Promise.all([
				listPromptPresets(),
				loadConversationPromptPreset(conversationId),
			]);
			if (isCancelled?.() || !ownsRead(claim)) return "stale";
			if (selected === null) {
				dispatch({ type: "recipe-unavailable" });
				return "not-found";
			}
			dispatch({ type: "recipe-adopted", claim, selected, presets });
			return "ready";
		} catch {
			if (!isCancelled?.() && ownsRead(claim)) {
				dispatch({ type: "load-failed" });
			}
			return "network";
		}
	};

	// ==[HUMAN APPROVED]== Applies one selection through the authoritative Conversation command;
	// `selectPreset` decides whether a pending leave must resolve first.
	const applySelection = (presetId: number, resolvingLeave = false): void => {
		if (conversation === null) return;
		if (busy && !(resolvingLeave && leaving)) return;
		const conversationId = conversation.id;
		dispatch({
			type: "operation-started",
			invalidateReads: true,
			conversationOperation: true,
		});
		const claim = conversationOperationClaim(stateRef.current);
		void runConversationCommand({
			revision: () => conversation.revision,
			send: (expectedRevision) =>
				applyConversationCommand(conversationId, expectedRevision, {
					type: "select-prompt-preset",
					promptPresetId: presetId,
				}),
			reconciliation: {
				adoptSnapshot: (next) => {
					if (!ownsConversationOperation(claim)) return;
					dispatch({ type: "conversation-adopted", conversationRevision: next.revision });
					onConversationChange(next);
				},
				showNotice: (message) => {
					if (ownsConversationOperation(claim)) {
						dispatch({ type: "notice-changed", notice: message });
					}
				},
			},
			notices: PRESET_COMMAND_NOTICES,
			callbacks: {
				onNotPlayable: () => {
					if (ownsConversationOperation(claim)) {
						dispatch({ type: "notice-changed", notice: PRESET_COMMAND_NOTICES.conflict });
					}
				},
				onNotRemovable: (reason) => {
					if (ownsConversationOperation(claim)) {
						dispatch({ type: "notice-changed", notice: reason });
					}
				},
				onApplied: async () => {
					if (!ownsConversationOperation(claim)) return;
					dispatch({ type: "notice-changed", notice: null });
					const refresh = await load();
					if (!ownsConversationOperation(claim)) return;
					if (refresh === "network") {
						dispatch({ type: "notice-changed", notice: PRESET_COMMAND_NOTICES.unreachable });
					} else if (refresh === "not-found") {
						dispatch({ type: "notice-changed", notice: PRESET_COMMAND_NOTICES.notFound });
					}
				},
			},
		}).finally(() => settleOperation(claim));
	};

	// ==[HUMAN APPROVED]== One library command execution: pending and notice state live here, and
	// the outcome's authoritative re-read refreshes the list and the selected
	// recipe. A success notice is caller-shaped so a rename, a duplication and
	// a deletion each name what happened.
	const runPresetCommand = async (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	): Promise<void> => {
		if (busy) return;
		if (dirty && command.type === "delete" && ready?.selected.id === command.presetId) {
			dispatch({
				type: "notice-changed",
				notice: "Save or discard the current block edit before deleting its preset.",
			});
			return;
		}
		dispatch({
			type: "operation-started",
			invalidateReads: true,
			clearNotice: true,
		});
		const claim = operationClaim(stateRef.current);
		try {
			const outcome = await applyPromptPresetCommand(command);
			if (!ownsOperation(claim)) return;
			switch (outcome.status) {
				case "applied":
				case "deleted": {
					const refresh = await load();
					if (!ownsOperation(claim)) return;
					if (reportRefreshFailure(refresh)) break;
					dispatch({ type: "notice-changed", notice: successNotice?.(outcome) ?? null });
					break;
				}
				case "conflict": {
					let message = `That preset changed elsewhere. It is now "${outcome.conflict.currentPreset.name}".`;
					if (command.type === "delete") {
						// ==[HUMAN APPROVED]== Either confirmed deletion value can conflict. Refresh before
						// the notice so a renewed confirmation shows the current name, revision
						// and impact instead of the values the author already confirmed.
						const refresh = await load();
						if (!ownsOperation(claim)) return;
						if (reportRefreshFailure(refresh)) break;
						if (outcome.conflict.reason === "deletion-impact") {
							message = presetDeletionImpactChangedNotice(
								outcome.conflict.currentPreset.name,
								outcome.conflict.currentPreset.conversationCount,
							);
						}
					}
					dispatch({ type: "notice-changed", notice: message });
					break;
				}
				case "not-removable":
				case "invalid":
					dispatch({ type: "notice-changed", notice: outcome.reason });
					break;
				case "not-found":
					dispatch({ type: "notice-changed", notice: "That preset is no longer in the Library." });
					break;
				default:
					dispatch({ type: "notice-changed", notice: LIBRARY_UNREACHABLE_NOTICE });
			}
		} catch {
			if (ownsOperation(claim)) {
				dispatch({ type: "notice-changed", notice: LIBRARY_UNREACHABLE_NOTICE });
			}
		} finally {
			settleOperation(claim);
		}
	};

	// ==[HUMAN APPROVED]== Switching presets with unsaved block edits defers the selection until
	// Save, Discard or Keep editing resolves the drafts, so a switch never
	// silently drops a block draft.
	const selectPreset = (presetId: number): void => {
		if (conversation === null) return;
		if (dirty) {
			dispatch({ type: "leave-requested", request: { kind: "select", presetId } });
			return;
		}
		applySelection(presetId);
	};

	const exportSelectedPreset = async (presetId: number, name: string): Promise<void> => {
		if (busy) return;
		dispatch({ type: "operation-started", clearNotice: true });
		const claim = operationClaim(stateRef.current);
		try {
			const native = await loadNativePromptPreset(presetId);
			if (!ownsOperation(claim)) return;
			const blob = new Blob([JSON.stringify(native, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${name.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "prompt-preset"}.json`;
			anchor.click();
			URL.revokeObjectURL(url);
			dispatch({ type: "notice-changed", notice: `Exported "${name}".` });
		} catch {
			if (ownsOperation(claim)) {
				dispatch({ type: "notice-changed", notice: "The Prompt Preset could not be exported." });
			}
		} finally {
			settleOperation(claim);
		}
	};

	const importPresetFile = async (file: File): Promise<void> => {
		if (busy) return;
		dispatch({
			type: "operation-started",
			invalidateReads: true,
			clearNotice: true,
		});
		const claim = operationClaim(stateRef.current);
		try {
			// ==[HUMAN APPROVED]== SAFETY: JSON.parse returns the JSON value that the review route validates again.
			const source = JSON.parse(await file.text()) as SillyTavernJsonValue;
			const native = parseNativePromptPreset(JSON.stringify(source));
			if (native !== null) {
				const outcome = await importNativePromptPreset(native);
				if (!ownsOperation(claim)) return;
				if (outcome.status !== "applied") {
					reportImportFailure(outcome);
					return;
				}
				await reloadAfterImport(claim, `Imported "${outcome.preset.name}" as a new preset.`);
				return;
			}
			const reviewOutcome = await reviewSillyTavernPromptPreset(
				source,
				file.name.replace(/\.json$/i, ""),
			);
			if (!ownsOperation(claim)) return;
			if (reviewOutcome.status !== "review") {
				reportImportFailure(reviewOutcome);
				return;
			}
			setReview({
				request: { source, name: reviewOutcome.preview.name },
				preview: reviewOutcome.preview,
				orderListId: reviewOutcome.preview.selectedOrderId,
			});
		} catch {
			if (ownsOperation(claim)) {
				dispatch({
					type: "notice-changed",
					notice: "The selected file is not valid Prompt Preset or SillyTavern JSON.",
				});
			}
		} finally {
			settleOperation(claim);
		}
	};

	const commitSillyTavernReview = async (): Promise<void> => {
		const currentReview = review;
		if (currentReview === null) return;
		if (busy) return;
		if (currentReview.preview.requiresOrderSelection && currentReview.orderListId === null) {
			dispatch({ type: "notice-changed", notice: "Choose an order list before importing." });
			return;
		}
		dispatch({ type: "operation-started", invalidateReads: true });
		const claim = operationClaim(stateRef.current);
		try {
			const outcome = await commitSillyTavernPromptPreset(
				currentReview.request.source,
				currentReview.request.name,
				currentReview.orderListId ?? undefined,
			);
			if (!ownsOperation(claim)) return;
			if (outcome.status !== "applied") {
				reportImportFailure(outcome);
				return;
			}
			setReview(null);
			await reloadAfterImport(claim, `Imported "${outcome.preview.preset.name}" as a new preset.`);
		} finally {
			settleOperation(claim);
		}
	};

	const selectSillyTavernOrder = async (orderListId: string): Promise<void> => {
		const currentReview = review;
		if (currentReview === null) return;
		if (busy) return;
		dispatch({ type: "operation-started" });
		const claim = operationClaim(stateRef.current);
		try {
			const outcome = await reviewSillyTavernPromptPreset(
				currentReview.request.source,
				currentReview.request.name,
				orderListId,
			);
			if (!ownsOperation(claim)) return;
			if (outcome.status === "review") {
				setReview({ ...currentReview, preview: outcome.preview, orderListId });
			} else if (outcome.status === "invalid") {
				dispatch({ type: "notice-changed", notice: outcome.reason });
			}
		} finally {
			settleOperation(claim);
		}
	};

	// ==[HUMAN APPROVED]== One recipe operation execution: pending and problem state live here, and
	// the applied response's fresh recipe read refreshes the selected recipe
	// through the shared acceptance rule while leaving the library list and
	// every other saved change untouched. When the operation submitted one
	// occurrence's draft, that exact version is retired on acceptance so saved
	// content never resurfaces as an unsaved edit.
	const runRecipeOperation = async (
		run: () => Promise<PromptPresetOperationOutcome>,
		submitted?: { blockId: number; draft: BlockDraft },
	): Promise<void> => {
		if (conversation === null) return;
		if (busy) return;
		const conversationId = conversation.id;
		dispatch({ type: "operation-started", clearProblem: true });
		const claim = operationClaim(stateRef.current);
		try {
			const outcome = await run();
			if (!ownsOperation(claim)) return;
			if (outcome.status !== "applied") {
				dispatch({
					type: "problem-changed",
					problem: outcome.status === "invalid"
						? outcome.reason
						: outcome.status === "not-found"
							? "The selected preset no longer exists."
							: "The Prompt Preset change could not be reached.",
				});
				return;
			}
			if (submitted !== undefined) {
				dispatch({ type: "drafts-submitted", submitted: { [submitted.blockId]: submitted.draft } });
			}
			dispatch({ type: "read-started" });
			const read = readClaim(stateRef.current);
			let fresh: ConversationPromptPreset | null;
			try {
				fresh = await loadConversationPromptPreset(conversationId);
			} catch {
				if (ownsOperation(claim)) {
					dispatch({
						type: "problem-changed",
						problem: "The Prompt Preset change could not be reloaded.",
					});
				}
				return;
			}
			if (!ownsOperation(claim)) return;
			if (fresh === null) {
				dispatch({ type: "recipe-unavailable" });
				return;
			}
			dispatch({ type: "recipe-adopted", claim: read, selected: fresh });
		} finally {
			settleOperation(claim);
		}
	};

	const setDraft = (blockId: number, draft: BlockDraft): void =>
		dispatch({ type: "draft-changed", blockId, draft });

	const clearDraft = (blockId: number): void => dispatch({ type: "draft-cleared", blockId });

	// ==[HUMAN APPROVED]== Save-on-leave submits every dirty occurrence in one typed domain
	// command. The authoritative recipe is read again before the leave completes
	// and adopted through the shared acceptance rule, retiring exactly the
	// submitted draft versions, while the local drafts remain available if
	// either request fails.
	const saveDrafts = async (
		preset: ConversationPromptPreset,
		claim: OperationClaim,
		conversationId: number,
	): Promise<string | null> => {
		if (stateRef.current.session.draftPresetId !== preset.id) {
			return "The selected Prompt Preset is no longer current.";
		}
		dispatch({ type: "read-started" });
		const { patches, submitted } = dirtyBlockPatches(preset, stateRef.current.drafts);
		const outcome = await savePromptPresetBlockPatches(preset.id, patches);
		if (!ownsOperation(claim)) return null;
		if (outcome.status !== "applied") {
			return outcome.status === "invalid"
				? outcome.reason
				: outcome.status === "not-found"
					? "The selected preset no longer exists."
					: "The Prompt Preset change could not be saved.";
		}
		dispatch({ type: "drafts-submitted", submitted });
		dispatch({ type: "read-started" });
		const read = readClaim(stateRef.current);
		try {
			const fresh = await loadConversationPromptPreset(conversationId);
			if (!ownsOperation(claim)) return null;
			if (fresh === null) return "The selected preset could not be reloaded.";
			dispatch({ type: "recipe-adopted", claim: read, selected: fresh });
			return null;
		} catch {
			return "The saved Prompt Preset could not be reloaded.";
		}
	};

	// ==[HUMAN APPROVED]== Completes a resolved leave: the drafts are gone and the deferred action
	// — closing the popup or applying the pending selection — runs.
	const finishLeave = (request: LeaveRequest): void => {
		dispatch({ type: "leave-resolved" });
		if (request.kind === "close") {
			onOpenChange(false);
		} else {
			applySelection(request.presetId, true);
		}
	};

	const saveAndLeave = async (): Promise<void> => {
		const request = stateRef.current.leaveRequest;
		const currentReady = stateRef.current.view.status === "ready" ? stateRef.current.view : null;
		if (stateRef.current.busy || conversation === null || currentReady === null || request === null) return;
		const conversationId = conversation.id;
		dispatch({ type: "operation-started", leaving: true });
		const claim = operationClaim(stateRef.current);
		try {
			const failure = await saveDrafts(currentReady.selected, claim, conversationId);
			if (!ownsOperation(claim)) return;
			if (failure !== null) {
				dispatch({ type: "leave-failed", problem: failure });
				return;
			}
			finishLeave(request);
		} finally {
			settleOperation(claim);
		}
	};

	const keepEditing = (): void => dispatch({ type: "leave-kept" });

	const discardAndLeave = (): void => {
		const request = leaveRequest;
		if (request === null) return;
		finishLeave(request);
	};

	const cancelSillyTavernReview = (): void => setReview(null);

	const requestOpenChange = (next: boolean): void => {
		if (!next && dirty) {
			dispatch({ type: "leave-requested", request: { kind: "close" } });
			return;
		}
		onOpenChange(next);
	};

	// ==[HUMAN APPROVED]== Escape and outside clicks take the same unsaved-drafts guard as the
	// close button, so a dirty block edit is never silently dropped by any
	// dismissal path.
	const guardDirtyDismiss = (event: { preventDefault: () => void }): void => {
		if (!dirty) return;
		event.preventDefault();
		dispatch({ type: "leave-requested", request: { kind: "close" } });
	};

	useAsyncEffect((isCancelled) => {
		const current = stateRef.current;
		if (current.session.key !== sessionKey) {
			// ==[HUMAN APPROVED]== Every open or Chat transition starts clean; a same-session revision
			// refresh keeps drafts.
			if (open) setReview(null);
			dispatch({
				type: "session-changed",
				sessionKey,
				conversationRevision: conversation?.revision ?? null,
			});
		} else if (open && current.session.knownRevision !== (conversation?.revision ?? null)) {
			dispatch({
				type: "conversation-revision-changed",
				conversationRevision: conversation?.revision ?? null,
			});
		}
		if (!open) return;
		void load(isCancelled);
	}, [open, conversation?.id, conversation?.revision]);

	return {
		view,
		drafts,
		busy,
		dirtyCount,
		notice,
		problem,
		leaveRequest,
		review,
		requestOpenChange,
		guardDirtyDismiss,
		selectPreset,
		runPresetCommand,
		exportSelectedPreset,
		importPresetFile,
		commitSillyTavernReview,
		selectSillyTavernOrder,
		cancelSillyTavernReview,
		runRecipeOperation,
		setDraft,
		clearDraft,
		saveAndLeave,
		keepEditing,
		discardAndLeave,
	};
}
