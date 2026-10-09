import {
	type ConversationSummary,
} from "../../conversation";
import { createConversationCommands } from "../../createConversationCommands";
import {
	applyPromptPresetCommand,
	commitSillyTavernPromptPreset,
	importNativePromptPreset,
	loadNativePromptPreset,
	parseNativePromptPreset,
	reviewSillyTavernPromptPreset,
	type PresetCommandOutcome,
	type PromptPresetCommand,
	type SillyTavernJsonValue,
} from "../../prompt-preset-library";
import { downloadNativePromptPreset } from "../../prompt-preset-download";
import { LIBRARY_UNREACHABLE_NOTICE } from "../../character-library";
import { CONVERSATION_UNREACHABLE_NOTICE } from "../../conversation-command-runner";
import { presetDeletionImpactChangedNotice } from "../../prompt-preset-presentation";
import {
	conversationOperationApplies,
	conversationOperationClaim,
	type EditorLoadResult,
	type OperationClaim,
	type OperationStartEffects,
} from "../../prompt-preset-editor-state";
import type { PromptPresetEditorRuntime } from "./usePromptPresetEditorRuntime";

const PRESET_COMMAND_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation no longer exists.",
	unreachable: CONVERSATION_UNREACHABLE_NOTICE,
};

// @approved
//  Each flow declares its own start effects at the call site, so adding a flow
// never requires editing a global registry: a selection supersedes reads and owns the Conversation
// race; a library command supersedes reads and clears the notice channel; committing an import
// supersedes reads; an order choice and an export keep reads current; the export clears the notice.
const SELECTION_EFFECTS: OperationStartEffects = {
	supersedesReads: true,
	ownsConversation: true,
	clearNotice: false,
	clearProblem: false,
};
const LIBRARY_WRITE_EFFECTS: OperationStartEffects = {
	supersedesReads: true,
	ownsConversation: false,
	clearNotice: true,
	clearProblem: false,
};
const IMPORT_COMMIT_EFFECTS: OperationStartEffects = {
	supersedesReads: true,
	ownsConversation: false,
	clearNotice: false,
	clearProblem: false,
};
const IMPORT_ORDER_EFFECTS: OperationStartEffects = {
	supersedesReads: false,
	ownsConversation: false,
	clearNotice: false,
	clearProblem: false,
};
const EXPORT_EFFECTS: OperationStartEffects = {
	supersedesReads: false,
	ownsConversation: false,
	clearNotice: true,
	clearProblem: false,
};

interface PromptPresetLibraryUnit {
	applySelection: (presetId: number) => void;
	selectPreset: (presetId: number) => void;
	runPresetCommand: (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => Promise<void>;
	exportSelectedPreset: (presetId: number, name: string) => Promise<void>;
	importPresetFile: (file: File) => Promise<void>;
	commitSillyTavernReview: () => Promise<void>;
	selectSillyTavernOrder: (orderListId: string) => Promise<void>;
	cancelSillyTavernReview: () => void;
}

// @approved
//  The library unit: the shared preset list, the per-Chat selection, native and
// SillyTavern interchange. It shares the runtime's settlement and one unified refresh path, so its
// flows cannot drift from the recipe unit's ownership rules.
export function usePromptPresetLibrary({
	runtime,
	conversation,
	onConversationChange,
}: {
	runtime: PromptPresetEditorRuntime;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
}): PromptPresetLibraryUnit {
	const { current, ready, dirty, dispatch, load, runOperation, ownsOperation } = runtime;

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
		outcome: { outcome: "invalid"; reason: string } | { outcome: "unusable"; reason: string } | { outcome: "network" },
	): void => {
		dispatch({
			type: "notice-changed",
			notice: outcome.outcome === "invalid" || outcome.outcome === "unusable" ? outcome.reason : LIBRARY_UNREACHABLE_NOTICE,
		});
	};
	// @approved
	//  The shared import epilogue: reload the library and the selected recipe,
	// then report the imported name once the fresh state is accepted.
	const reloadAfterImport = async (claim: OperationClaim, notice: string): Promise<void> => {
		const refresh = await load();
		if (!ownsOperation(claim)) return;
		if (reportRefreshFailure(refresh)) return;
		dispatch({ type: "notice-changed", notice });
	};

	// @approved
	//  Applies one selection through the authoritative Conversation command.
	// `selectPreset` decides whether a pending leave must resolve first; the runtime owns the
	// operation gate once the selection is ready to start.
	const { run } = createConversationCommands(conversation?.id ?? null, {
		revision: () => conversation?.revision ?? null,
		onConversationChange: (next) => {
			dispatch({ type: "conversation-adopted", conversationRevision: next.revision });
			onConversationChange(next);
		},
		setNotice: (notice) => dispatch({ type: "notice-changed", notice }),
	});

	const applySelection = (presetId: number): void => {
		if (conversation === null) return;
		void runOperation(SELECTION_EFFECTS, async () => {
			const conversationClaim = conversationOperationClaim(runtime.current());
			await run({
						type: "select-prompt-preset",
						promptPresetId: presetId,
					}, { notices: PRESET_COMMAND_NOTICES, isCurrent: () => conversationOperationApplies(runtime.current(), conversationClaim), onNotPlayable: () => {
						if (conversationOperationApplies(runtime.current(), conversationClaim)) {
							dispatch({ type: "notice-changed", notice: PRESET_COMMAND_NOTICES.conflict });
						}
					}, onNotRemovable: (reason) => {
						if (conversationOperationApplies(runtime.current(), conversationClaim)) {
							dispatch({ type: "notice-changed", notice: reason });
						}
					},
				onApplied: () => {
						if (!conversationOperationApplies(runtime.current(), conversationClaim)) return;
						dispatch({ type: "notice-changed", notice: null });
					} });
		});
	};

	// @approved
	//  One library command execution: pending and notice state live here, and
	// the outcome's authoritative re-read refreshes the list and the selected
	// recipe. A success notice is caller-shaped so a rename, a duplication and
	// a deletion each name what happened.
	const runPresetCommand = async (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	): Promise<void> => {
		if (dirty && command.type === "delete" && ready?.selected.id === command.presetId) {
			dispatch({
				type: "notice-changed",
				notice: "Save or discard the current block edit before deleting its preset.",
			});
			return;
		}
		await runOperation(LIBRARY_WRITE_EFFECTS, async (claim) => {
			try {
				const outcome = await applyPromptPresetCommand(command);
				if (!ownsOperation(claim)) return;
				switch (outcome.outcome) {
					case "available": {
						if (outcome.value.outcome !== "applied" && outcome.value.outcome !== "deleted") {
							dispatch({ type: "notice-changed", notice: LIBRARY_UNREACHABLE_NOTICE });
							break;
						}
						const refresh = await load();
						if (!ownsOperation(claim)) return;
						if (reportRefreshFailure(refresh)) break;
						dispatch({ type: "notice-changed", notice: successNotice?.(outcome) ?? null });
						break;
					}
					case "conflict": {
						let message = `That preset changed elsewhere. It is now "${outcome.currentPreset.name}".`;
						const refresh = await load();
						if (!ownsOperation(claim)) return;
						if (reportRefreshFailure(refresh)) break;
						if (command.type === "delete") {
							// @approved
							//  Either confirmed deletion value can conflict. Refresh before
							// the notice so a renewed confirmation shows the current name, revision
							// and impact instead of the values the author already confirmed.
							if (outcome.reason === "deletion-impact") {
								message = presetDeletionImpactChangedNotice(
									outcome.currentPreset.name,
									outcome.currentPreset.conversationCount,
								);
							}
						}
						dispatch({ type: "notice-changed", notice: message });
						break;
					}
					case "not-removable":
					case "invalid":
					case "unusable":
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
			}
		});
	};

	// @approved
	//  Switching presets with unsaved block edits defers the selection until
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
		await runOperation(EXPORT_EFFECTS, async (claim) => {
			try {
				const native = await loadNativePromptPreset(presetId);
				if (!ownsOperation(claim)) return;
				downloadNativePromptPreset(name, native);
				dispatch({ type: "notice-changed", notice: `Exported "${name}".` });
			} catch {
				if (ownsOperation(claim)) {
					dispatch({ type: "notice-changed", notice: "The Prompt Preset could not be exported." });
				}
			}
		});
	};

	const importPresetFile = async (file: File): Promise<void> => {
		await runOperation(LIBRARY_WRITE_EFFECTS, async (claim) => {
			try {
				// @approved
				//  SAFETY: JSON.parse returns the JSON value that the review route validates again.
				const source = JSON.parse(await file.text()) as SillyTavernJsonValue;
				const native = parseNativePromptPreset(JSON.stringify(source));
				if (native !== null) {
					const outcome = await importNativePromptPreset(native);
					if (!ownsOperation(claim)) return;
					if (outcome.outcome === "available") {
						if (outcome.value.outcome !== "applied") {
							reportImportFailure({ outcome: "network" });
							return;
						}
						await reloadAfterImport(claim, `Imported "${outcome.value.preset.name}" as a new preset.`);
						return;
					}
					reportImportFailure(outcome);
					return;
				}
				const reviewOutcome = await reviewSillyTavernPromptPreset(
					source,
					file.name.replace(/\.json$/i, ""),
				);
				if (!ownsOperation(claim)) return;
				if (reviewOutcome.outcome !== "available") {
					reportImportFailure(reviewOutcome);
					return;
				}
				dispatch({
					type: "review-changed",
					review: {
						request: { source, name: reviewOutcome.value.name },
						preview: reviewOutcome.value,
						orderListId: reviewOutcome.value.selectedOrderId,
					},
				});
			} catch {
				if (ownsOperation(claim)) {
					dispatch({
						type: "notice-changed",
						notice: "The selected file is not valid Prompt Preset or SillyTavern JSON.",
					});
				}
			}
		});
	};

	const commitSillyTavernReview = async (): Promise<void> => {
		const currentReview = current().review;
		if (currentReview === null) return;
		if (currentReview.preview.requiresOrderSelection && currentReview.orderListId === null) {
			dispatch({ type: "notice-changed", notice: "Choose an order list before importing." });
			return;
		}
		await runOperation(IMPORT_COMMIT_EFFECTS, async (claim) => {
			const outcome = await commitSillyTavernPromptPreset(
				currentReview.request.source,
				currentReview.request.name,
				currentReview.orderListId ?? undefined,
			);
			if (!ownsOperation(claim)) return;
			if (outcome.outcome !== "available") {
				reportImportFailure(outcome);
				return;
			}
			dispatch({ type: "review-changed", review: null });
			await reloadAfterImport(claim, `Imported "${outcome.value.preset.name}" as a new preset.`);
		});
	};

	const selectSillyTavernOrder = async (orderListId: string): Promise<void> => {
		if (orderListId === "") return;
		const currentReview = current().review;
		if (currentReview === null) return;
		await runOperation(IMPORT_ORDER_EFFECTS, async (claim) => {
			const outcome = await reviewSillyTavernPromptPreset(
				currentReview.request.source,
				currentReview.request.name,
				orderListId,
			);
			if (!ownsOperation(claim)) return;
			if (outcome.outcome === "available") {
				dispatch({
					type: "review-changed",
					review: { ...currentReview, preview: outcome.value, orderListId },
				});
			} else {
				reportImportFailure(outcome);
			}
		});
	};

	const cancelSillyTavernReview = (): void => dispatch({ type: "review-changed", review: null });

	return {
		applySelection,
		selectPreset,
		runPresetCommand,
		exportSelectedPreset,
		importPresetFile,
		commitSillyTavernReview,
		selectSillyTavernOrder,
		cancelSillyTavernReview,
	};
}
