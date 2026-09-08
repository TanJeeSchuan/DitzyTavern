import { useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	applyConversationCommand,
	loadConversationPromptPreset,
	type ConversationPromptPreset,
	type ConversationSummary,
	type PromptPresetOperationOutcome,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
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
	type PromptPresetBlockPatch,
	type PromptPresetSummary,
	type SillyTavernJsonValue,
} from "../prompt-preset-library";
import { LIBRARY_UNREACHABLE_NOTICE } from "../lib/command-outcome";
import { presetDeletionImpactChangedNotice } from "../prompt-preset-presentation";
import { useAsyncEffect } from "../lib/use-async";
import { PromptPresetLibrarySection } from "./prompt-preset/PromptPresetLibrarySection";
import { PromptPresetRecipeEditor, blockDraftEquals, dirtyDraftCount, draftIsDirty, type BlockDraft } from "./prompt-preset/PromptPresetRecipeEditor";
import { PromptPresetImportReviewDialog, type SillyTavernReview } from "./prompt-preset/PromptPresetImportReviewDialog";
import { UnsavedBlockEditDialog } from "./prompt-preset/UnsavedBlockEditDialog";

// ==[HUMAN APPROVED]== The preset editor is a popup rather than a primary panel: the agreed
// exception in the design direction, because a recipe is edited against the
// Chat it assembles for. The library section manages the shared presets and
// the per-Chat selection; ordering and enablement persist immediately through
// their authoritative operations. Referenced source text is read-only here —
// it belongs to the Participant it comes from — while an authored instruction
// block owns its name, text, and outgoing role, each one a per-block draft
// with its own Save and Cancel. The history slot exposes no text or role
// controls at all, because its entries keep the roles of their own Messages.

type PresetView =
	| { status: "loading" }
	| { status: "ready"; presets: PromptPresetSummary[]; selected: ConversationPromptPreset }
	| { status: "unavailable" };

type LeaveRequest = { kind: "close" } | { kind: "select"; presetId: number };

type EditorOperation = "busy" | "leave";

type LoadResult = "ready" | "not-found" | "network" | "stale";

const PRESET_COMMAND_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation no longer exists.",
	unreachable: "The Conversation could not be reached.",
};

export function PromptPresetDialog({
	conversation,
	onConversationChange,
	open,
	onOpenChange,
}: {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [view, setView] = useState<PresetView>({ status: "loading" });
	const [notice, setNotice] = useState<string | null>(null);
	const [operation, setOperation] = useState<EditorOperation | null>(null);
	// ==[HUMAN APPROVED]== The unsaved block drafts, keyed by the occurrence they belong to.
	// Ordering and enablement have no draft state: they persist immediately
	// through their authoritative operations.
	const [drafts, setDrafts] = useState<Record<number, BlockDraft>>({});
	const [problem, setProblem] = useState<string | null>(null);
	const [leaveRequest, setLeaveRequest] = useState<LeaveRequest | null>(null);
	const [sillyTavernReview, setSillyTavernReview] = useState<SillyTavernReview | null>(null);
	const sessionKey = open ? `open:${conversation?.id ?? "none"}` : "closed";
	const draftPresetRef = useRef<number | null>(null);
	// ==[HUMAN APPROVED]== Draft versions a successful save submitted, held until the next
	// accepted reconciliation retires them. A save's own reload may be dropped
	// by a newer read, so retirement is tied to whichever read is accepted,
	// not to the request that submitted the save.
	const pendingRetireRef = useRef<Record<number, BlockDraft> | null>(null);
	const sessionRef = useRef({
		key: "",
		id: 0,
		latestLoad: 0,
		latestOperation: 0,
		latestConversationOperation: 0,
		knownRevision: conversation?.revision ?? null,
	});
	const sessionChanged = sessionRef.current.key !== sessionKey;
	if (sessionChanged) {
		sessionRef.current = {
			key: sessionKey,
			id: sessionRef.current.id + 1,
			latestLoad: 0,
			latestOperation: 0,
			latestConversationOperation: 0,
			knownRevision: conversation?.revision ?? null,
		};
	} else if (open && sessionRef.current.knownRevision !== (conversation?.revision ?? null)) {
		sessionRef.current.knownRevision = conversation?.revision ?? null;
		sessionRef.current.latestLoad += 1;
		sessionRef.current.latestConversationOperation += 1;
	}
	const sessionId = sessionRef.current.id;
	const ownsSession = (id: number, conversationId = conversation?.id): boolean =>
		sessionRef.current.id === id && open && conversationId === conversation?.id;
	const ownsConversationOperation = (
		id: number,
		conversationId: number,
		operationId: number,
		conversationOperationId: number,
	): boolean =>
		ownsSession(id, conversationId) &&
		operationId === sessionRef.current.latestOperation &&
		conversationOperationId === sessionRef.current.latestConversationOperation;

	// ==[HUMAN APPROVED]== The one session-owned acceptance rule for a selected-recipe read.
	// Every read that can become the displayed recipe — initial loads,
	// Conversation refreshes and mutation reloads — adopts the fresh recipe
	// through here and nowhere else, so ordering and draft reconciliation can
	// never diverge. A read is accepted only while it still owns the session,
	// the Conversation and the newest read epoch; anything older is dropped.
	// Drafts are reconciled against the adopted recipe: switching presets
	// clears the draft set, a reload prunes drafts for occurrences the recipe
	// no longer contains, and drafts a successful save submitted are retired
	// once the reconciled recipe is accepted — but only the submitted version,
	// never a newer local edit.
	const acceptSelectedRecipe = (
		selected: ConversationPromptPreset,
		readId: number,
		options: { presets?: PromptPresetSummary[] } = {},
	): void => {
		if (!ownsSession(sessionId, conversation?.id) || readId !== sessionRef.current.latestLoad) return;
		if (draftPresetRef.current !== selected.id) {
			draftPresetRef.current = selected.id;
			pendingRetireRef.current = null;
			setDrafts({});
		} else {
			const retire = pendingRetireRef.current;
			pendingRetireRef.current = null;
			const alive = new Set(selected.slots.map((slot) => slot.id));
			setDrafts((current) => {
				let kept = current;
				if (retire !== null) {
					for (const key of Object.keys(current)) {
						const blockId = Number(key);
						const submitted = retire[blockId];
						if (submitted !== undefined && blockDraftEquals(submitted, current[blockId])) {
							kept = { ...kept };
							delete kept[blockId];
						}
					}
				}
				return Object.fromEntries(Object.entries(kept).filter(([draftId]) => alive.has(Number(draftId))));
			});
		}
		setView((current) => ({
			status: "ready",
			presets: options.presets ?? (current.status === "ready" ? current.presets : []),
			selected,
		}));
	};

	const load = async (id = sessionRef.current.id, isCancelled?: () => boolean): Promise<LoadResult> => {
		if (!open || !ownsSession(id)) return "stale";
		if (conversation === null) {
			if (ownsSession(id)) {
				draftPresetRef.current = null;
				setDrafts({});
				setView({ status: "unavailable" });
			}
			return "not-found";
		}
		const conversationId = conversation.id;
		const loadId = ++sessionRef.current.latestLoad;
		try {
			const [presets, selected] = await Promise.all([
				listPromptPresets(),
				loadConversationPromptPreset(conversationId),
			]);
			if (isCancelled?.() || !ownsSession(id, conversationId) || loadId !== sessionRef.current.latestLoad) return "stale";
			if (selected === null) {
				draftPresetRef.current = null;
				setDrafts({});
				setView({ status: "unavailable" });
				return "not-found";
			}
			acceptSelectedRecipe(selected, loadId, { presets });
			return "ready";
		} catch {
			if (!isCancelled?.() && ownsSession(id, conversationId) && loadId === sessionRef.current.latestLoad) {
				setView((current) => current.status === "ready" ? current : { status: "unavailable" });
			}
			return "network";
		}
	};

	useAsyncEffect((isCancelled) => {
		if (!open) return;
		if (sessionChanged) {
			// ==[HUMAN APPROVED]== Every open or Chat transition starts clean: transient forms,
			// notices, drafts and pending leaves belong to one popup session, not to
			// the Chat's lifetime. Same-session revision refreshes keep drafts.
			setNotice(null);
			draftPresetRef.current = null;
			pendingRetireRef.current = null;
			setDrafts({});
			setProblem(null);
			setLeaveRequest(null);
			setOperation(null);
			setSillyTavernReview(null);
			setView({ status: "loading" });
		} else {
			// ==[HUMAN APPROVED]== A newer Conversation snapshot invalidates pending responses, but its refresh is
			// unrelated to the block drafts owned by this editor session.
		}
		void load(sessionRef.current.id, isCancelled);
	}, [open, conversation?.id, conversation?.revision]);

	// ==[HUMAN APPROVED]== One library command execution: pending and notice state live
	// here, and the outcome's authoritative re-read refreshes the list and the
	// selected recipe. A success notice is caller-shaped so a rename, a
	// duplication and a deletion each name what happened.
	const runPresetCommand = async (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => {
		if (sessionRef.current.id !== sessionId || operation !== null) return;
		if (dirty && command.type === "delete" && ready?.selected.id === command.presetId) {
			setNotice("Save or discard the current block edit before deleting its preset.");
			return;
		}
		const operationId = ++sessionRef.current.latestOperation;
		sessionRef.current.latestLoad += 1;
		setOperation("busy");
		setNotice(null);
		try {
			const outcome = await applyPromptPresetCommand(command);
			if (!ownsSession(sessionId) || operationId !== sessionRef.current.latestOperation) return;
			switch (outcome.status) {
				case "applied":
				case "deleted": {
					const refresh = await load(sessionId);
					if (!ownsSession(sessionId) || operationId !== sessionRef.current.latestOperation) return;
					if (refresh === "network") {
						setNotice(LIBRARY_UNREACHABLE_NOTICE);
						break;
					}
					if (refresh === "not-found") {
						setNotice("The selected Conversation could not be loaded.");
						break;
					}
					setNotice(successNotice?.(outcome) ?? null);
					break;
				}
				case "conflict": {
					let message = `That preset changed elsewhere. It is now "${outcome.conflict.currentPreset.name}".`;
					if (command.type === "delete") {
						// ==[HUMAN APPROVED]== Either confirmed deletion value can conflict. Refresh before the
						// notice so a renewed confirmation shows the current name, revision and
						// impact instead of the values the author already confirmed. Nothing is
						// resubmitted automatically.
						const refresh = await load(sessionId);
						if (!ownsSession(sessionId) || operationId !== sessionRef.current.latestOperation) return;
						if (refresh === "network") {
							setNotice(LIBRARY_UNREACHABLE_NOTICE);
							break;
						}
						if (refresh === "not-found") {
							setNotice("The selected Conversation could not be loaded.");
							break;
						}
						if (outcome.conflict.reason === "deletion-impact") {
							message = presetDeletionImpactChangedNotice(
								outcome.conflict.currentPreset.name,
								outcome.conflict.currentPreset.conversationCount,
							);
						}
					}
					setNotice(message);
					break;
				}
				case "not-removable":
				case "invalid":
					setNotice(outcome.reason);
					break;
				case "not-found":
					setNotice("That preset is no longer in the Library.");
					break;
				default:
					setNotice(LIBRARY_UNREACHABLE_NOTICE);
			}
		} catch {
			if (ownsSession(sessionId) && operationId === sessionRef.current.latestOperation) {
				setNotice(LIBRARY_UNREACHABLE_NOTICE);
			}
		} finally {
			if (ownsSession(sessionId) && operationId === sessionRef.current.latestOperation) {
				setOperation(null);
			}
		}
	};

	// ==[HUMAN APPROVED]== Applies one selection through the authoritative Conversation
	// command; `selectPreset` decides whether a pending leave must resolve
	// first.
	const applySelection = (presetId: number, resolvingLeave = false) => {
		if (conversation === null) return;
		if (operation !== null && !(resolvingLeave && operation === "leave")) return;
		const id = sessionId;
		const conversationId = conversation.id;
		const operationId = ++sessionRef.current.latestOperation;
		const conversationOperationId = ++sessionRef.current.latestConversationOperation;
		sessionRef.current.latestLoad += 1;
		setOperation("busy");
		void runConversationCommand({
			revision: () => conversation.revision,
			send: (expectedRevision) =>
				applyConversationCommand(conversationId, expectedRevision, {
					type: "select-prompt-preset",
					promptPresetId: presetId,
				}),
			reconciliation: {
				adoptSnapshot: (next) => {
					if (ownsConversationOperation(id, conversationId, operationId, conversationOperationId)) {
						sessionRef.current.knownRevision = next.revision;
						onConversationChange(next);
					}
				},
				showNotice: (message) => {
					if (ownsConversationOperation(id, conversationId, operationId, conversationOperationId)) setNotice(message);
				},
			},
			notices: PRESET_COMMAND_NOTICES,
			callbacks: {
				onNotPlayable: () => {
					if (ownsConversationOperation(id, conversationId, operationId, conversationOperationId)) setNotice(PRESET_COMMAND_NOTICES.conflict);
				},
				onNotRemovable: (reason) => {
					if (ownsConversationOperation(id, conversationId, operationId, conversationOperationId)) setNotice(reason);
				},
				onApplied: async () => {
					if (!ownsConversationOperation(id, conversationId, operationId, conversationOperationId)) return;
					setNotice(null);
					const refresh = await load(id);
					if (!ownsConversationOperation(id, conversationId, operationId, conversationOperationId)) return;
					if (refresh === "network") setNotice(PRESET_COMMAND_NOTICES.unreachable);
					else if (refresh === "not-found") setNotice(PRESET_COMMAND_NOTICES.notFound);
				},
			},
		}).finally(() => {
			if (ownsSession(id, conversationId) && operationId === sessionRef.current.latestOperation) setOperation(null);
		});
	};

	// ==[HUMAN APPROVED]== Switching presets with unsaved block edits defers the selection
	// until Save, Discard or Keep editing resolves the drafts, so a switch
	// never silently drops a block draft.
	const selectPreset = (presetId: number) => {
		if (conversation === null) return;
		if (dirty) {
			setLeaveRequest({ kind: "select", presetId });
			return;
		}
		applySelection(presetId);
	};


	const exportSelectedPreset = async (presetId: number, name: string) => {
		if (sessionRef.current.id !== sessionId || operation !== null) return;
		const id = sessionId;
		const operationId = ++sessionRef.current.latestOperation;
		setOperation("busy");
		setNotice(null);
		try {
			const native = await loadNativePromptPreset(presetId);
			if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return;
			const blob = new Blob([JSON.stringify(native, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${name.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "prompt-preset"}.json`;
			anchor.click();
			URL.revokeObjectURL(url);
			setNotice(`Exported "${name}".`);
		} catch {
			if (ownsSession(id) && operationId === sessionRef.current.latestOperation) {
				setNotice("The Prompt Preset could not be exported.");
			}
		} finally {
			if (ownsSession(id) && operationId === sessionRef.current.latestOperation) setOperation(null);
		}
	};

	const importPresetFile = async (file: File) => {
		if (sessionRef.current.id !== sessionId || operation !== null) return;
		const id = sessionId;
		const operationId = ++sessionRef.current.latestOperation;
		sessionRef.current.latestLoad += 1;
		setOperation("busy");
		setNotice(null);
		try {
			// ==[HUMAN APPROVED]== SAFETY: JSON.parse returns the JSON value that the review route validates again.
			const source = JSON.parse(await file.text()) as SillyTavernJsonValue;
			const native = parseNativePromptPreset(JSON.stringify(source));
			if (native !== null) {
				const outcome = await importNativePromptPreset(native);
				if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return;
				if (outcome.status === "invalid") {
					setNotice(outcome.reason);
					return;
				}
				if (outcome.status === "network") {
					setNotice(LIBRARY_UNREACHABLE_NOTICE);
					return;
				}
				const refresh = await load(id);
				if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return;
				if (refresh === "network") {
					setNotice(LIBRARY_UNREACHABLE_NOTICE);
					return;
				}
				if (refresh === "not-found") {
					setNotice("The selected Conversation could not be loaded.");
					return;
				}
				setNotice(`Imported "${outcome.preset.name}" as a new preset.`);
				return;
			}
			const review = await reviewSillyTavernPromptPreset(
				source,
				file.name.replace(/\.json$/i, ""),
			);
			if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return;
			if (review.status === "invalid") {
				setNotice(review.reason);
				return;
			}
			if (review.status === "network") {
				setNotice(LIBRARY_UNREACHABLE_NOTICE);
				return;
			}
			setSillyTavernReview({
				request: { source, name: review.preview.name },
				preview: review.preview,
				orderListId: review.preview.selectedOrderId,
			});
		} catch {
			if (ownsSession(id) && operationId === sessionRef.current.latestOperation) {
				setNotice("The selected file is not valid Prompt Preset or SillyTavern JSON.");
			}
		} finally {
			if (ownsSession(id) && operationId === sessionRef.current.latestOperation) setOperation(null);
		}
	};

	const commitSillyTavernReview = async () => {
		if (sillyTavernReview === null) return;
		if (sessionRef.current.id !== sessionId || operation !== null) return;
		if (sillyTavernReview.preview.requiresOrderSelection && sillyTavernReview.orderListId === null) {
			setNotice("Choose an order list before importing.");
			return;
		}
		const id = sessionId;
		const operationId = ++sessionRef.current.latestOperation;
		sessionRef.current.latestLoad += 1;
		setOperation("busy");
		try {
			const outcome = await commitSillyTavernPromptPreset(
				sillyTavernReview.request.source,
				sillyTavernReview.request.name,
				sillyTavernReview.orderListId ?? undefined,
			);
			if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return;
			if (outcome.status === "invalid") {
				setNotice(outcome.reason);
				return;
			}
			if (outcome.status === "network") {
				setNotice(LIBRARY_UNREACHABLE_NOTICE);
				return;
			}
			setSillyTavernReview(null);
			const refresh = await load(id);
			if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return;
			if (refresh === "network") {
				setNotice(LIBRARY_UNREACHABLE_NOTICE);
				return;
			}
			if (refresh === "not-found") {
				setNotice("The selected Conversation could not be loaded.");
				return;
			}
			setNotice(`Imported "${outcome.preview.preset.name}" as a new preset.`);
		} finally {
			if (ownsSession(id) && operationId === sessionRef.current.latestOperation) setOperation(null);
		}
	};

	const selectSillyTavernOrder = async (orderListId: string) => {
		if (sillyTavernReview === null) return;
		if (sessionRef.current.id !== sessionId || operation !== null) return;
		const id = sessionId;
		const operationId = ++sessionRef.current.latestOperation;
		setOperation("busy");
		try {
			const outcome = await reviewSillyTavernPromptPreset(
				sillyTavernReview.request.source,
				sillyTavernReview.request.name,
				orderListId,
			);
			if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return;
			if (outcome.status === "review") {
				setSillyTavernReview({ ...sillyTavernReview, preview: outcome.preview, orderListId });
			} else if (outcome.status === "invalid") {
				setNotice(outcome.reason);
			}
		} finally {
			if (ownsSession(id) && operationId === sessionRef.current.latestOperation) setOperation(null);
		}
	};

	// ==[HUMAN APPROVED]== One recipe operation execution: pending and problem state live
	// here, and the applied response's fresh recipe read refreshes the selected
	// recipe through the shared acceptance rule while leaving the library list
	// and every other saved change untouched. A draft cannot outlive the
	// occurrence it belongs to. When the operation submitted one occurrence's
	// draft, that exact version is retired on acceptance so saved content never
	// resurfaces as an unsaved edit. The ready view is only reachable when a
	// Conversation is selected, so its id is always available here.
	const runOperation = async (
		run: () => Promise<PromptPresetOperationOutcome>,
		submitted?: { blockId: number; draft: BlockDraft },
	) => {
		if (conversation === null) return;
		if (operation !== null) return;
		const id = sessionId;
		const conversationId = conversation.id;
		const operationId = ++sessionRef.current.latestOperation;
		setOperation("busy");
		setProblem(null);
		try {
			const outcome = await run();
			if (!ownsSession(id, conversationId) || operationId !== sessionRef.current.latestOperation) return;
			if (outcome.status !== "applied") {
				setProblem(outcome.status === "invalid"
					? outcome.reason
					: outcome.status === "not-found"
						? "The selected preset no longer exists."
						: "The Prompt Preset change could not be reached.");
				return;
			}
			if (submitted !== undefined) {
				pendingRetireRef.current = { ...pendingRetireRef.current, [submitted.blockId]: submitted.draft };
			}
			let fresh: ConversationPromptPreset | null;
			const readId = ++sessionRef.current.latestLoad;
			try {
				fresh = await loadConversationPromptPreset(conversationId);
			} catch {
				setProblem("The Prompt Preset change could not be reloaded.");
				return;
			}
			if (!ownsSession(id, conversationId) || operationId !== sessionRef.current.latestOperation) return;
			if (fresh === null) {
				draftPresetRef.current = null;
				setDrafts({});
				setView({ status: "unavailable" });
				return;
			}
			acceptSelectedRecipe(fresh, readId);
		} finally {
			if (ownsSession(id, conversationId) && operationId === sessionRef.current.latestOperation) setOperation(null);
		}
	};

	const clearDraft = (blockId: number) =>
		setDrafts((current) => Object.fromEntries(
			Object.entries(current).filter(([id]) => Number(id) !== blockId),
		));

	// ==[HUMAN APPROVED]== Save-on-leave submits every dirty occurrence in one typed domain
	// command. The authoritative recipe is read again before the leave completes
	// and adopted through the shared acceptance rule, retiring exactly the
	// submitted draft versions, while the local drafts remain available if
	// either request fails.
	const saveDrafts = async (
		preset: ConversationPromptPreset,
		id: number,
		operationId: number,
		conversationId: number,
	): Promise<string | null> => {
		if (draftPresetRef.current !== preset.id) return "The selected Prompt Preset is no longer current.";
		sessionRef.current.latestLoad += 1;
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
		const outcome = await savePromptPresetBlockPatches(preset.id, patches);
		if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return null;
		if (outcome.status !== "applied") {
			return outcome.status === "invalid"
				? outcome.reason
				: outcome.status === "not-found"
					? "The selected preset no longer exists."
					: "The Prompt Preset change could not be saved.";
		}
		pendingRetireRef.current = { ...pendingRetireRef.current, ...submitted };
		const readId = ++sessionRef.current.latestLoad;
		try {
			const fresh = await loadConversationPromptPreset(conversationId);
			if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation) return null;
			if (fresh === null) return "The selected preset could not be reloaded.";
			acceptSelectedRecipe(fresh, readId);
			return null;
		} catch {
			return "The saved Prompt Preset could not be reloaded.";
		}
	};

	// ==[HUMAN APPROVED]== Completes a resolved leave: the drafts are gone, the guard
	// closes, and the deferred action — closing the popup or applying the
	// pending selection — runs.
	const finishLeave = (request: LeaveRequest) => {
		draftPresetRef.current = null;
		pendingRetireRef.current = null;
		setDrafts({});
		setLeaveRequest(null);
		if (request.kind === "close") {
			onOpenChange(false);
		} else {
			applySelection(request.presetId, true);
		}
	};

	const ready = view.status === "ready" ? view : null;
	const editorBusy = operation !== null;
	const dirty =
		ready !== null &&
		ready.selected.slots.some((slot) => {
			const draft = drafts[slot.id];
			return draft !== undefined && draftIsDirty(slot, draft);
		});

	return (
		<>
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && dirty) {
					setLeaveRequest({ kind: "close" });
					return;
				}
				onOpenChange(next);
			}}
		>
			<DialogContent
				className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
				// ==[HUMAN APPROVED]== Escape and outside clicks take the same unsaved-drafts guard
				// as the close button, so a dirty block edit is never silently
				// dropped by any dismissal path.
				onEscapeKeyDown={(event) => {
					if (dirty) {
						event.preventDefault();
						setLeaveRequest({ kind: "close" });
					}
				}}
				onInteractOutside={(event) => {
					if (dirty) {
						event.preventDefault();
						setLeaveRequest({ kind: "close" });
					}
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{view.status === "ready"
							? `Prompt Preset: ${view.selected.name}`
							: "Prompt Preset"}
					</DialogTitle>
					<DialogDescription>
						Shared recipes live in one library and each Chat selects one. Ordering
						and enablement save immediately; referenced content is read-only here,
						edited on the Participant it comes from. Authored instruction text
						saves per block.
					</DialogDescription>
				</DialogHeader>
				{view.status === "loading" && (
					<div role="status">
						<span className="sr-only">Loading the Prompt Preset library…</span>
						<ol aria-hidden="true" className="flex flex-col gap-3">
							{Array.from({ length: 4 }, (_, index) => (
								<li
									key={index}
									className="h-16 animate-pulse rounded-lg bg-muted/50 ring-1 ring-foreground/10"
								/>
							))}
						</ol>
					</div>
				)}
				{view.status === "unavailable" && (
					<p className="text-muted-foreground">
						The Prompt Preset library could not be loaded.
					</p>
				)}
				{view.status === "ready" && (
					<>
						<PromptPresetLibrarySection
							presets={view.presets}
							selectedId={view.selected.id}
							pending={operation !== null}
							onSelect={selectPreset}
							onCommand={(command, successNotice) => void runPresetCommand(command, successNotice)}
							onImportFile={(file) => void importPresetFile(file)}
							onExport={(presetId, name) => void exportSelectedPreset(presetId, name)}
						/>
						<PromptPresetRecipeEditor
							preset={view.selected}
							drafts={drafts}
							pending={editorBusy}
							problem={problem}
							onDraftChange={(blockId, draft) => {
								draftPresetRef.current = ready?.selected.id ?? null;
								setDrafts((current) => ({ ...current, [blockId]: draft }));
							}}
							onDraftCancel={clearDraft}
							onOperation={(run, submitted) => void runOperation(run, submitted)}
						/>
					</>
				)}
				{notice !== null && (
					<p className="text-sm text-muted-foreground" role="status">
						{notice}
					</p>
				)}
				{ready !== null && leaveRequest !== null && (
					<UnsavedBlockEditDialog
						open
						count={dirtyDraftCount(ready.selected, drafts)}
						kind={leaveRequest.kind}
						onKeepEditing={() => setLeaveRequest(null)}
						onDiscard={() => {
							const request = leaveRequest;
							// ==[HUMAN APPROVED]== Discard abandons only the block drafts; ordering
							// and toggles were already persisted and stay.
							finishLeave(request);
						}}
						onSave={async () => {
							if (operation !== null || conversation === null) return;
							const request = leaveRequest;
							const id = sessionId;
							const operationId = ++sessionRef.current.latestOperation;
							setOperation("leave");
							try {
								const failure = await saveDrafts(ready.selected, id, operationId, conversation.id);
								if (!ownsSession(id) || operationId !== sessionRef.current.latestOperation || request === null) return;
								if (failure !== null) {
									setProblem(failure);
									setLeaveRequest(null);
									return;
								}
								finishLeave(request);
							} finally {
								if (ownsSession(id) && operationId === sessionRef.current.latestOperation) setOperation(null);
							}
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
		<PromptPresetImportReviewDialog
			review={sillyTavernReview}
			busy={editorBusy}
			onOrderSelect={(orderListId) => void selectSillyTavernOrder(orderListId)}
			onCancel={() => setSillyTavernReview(null)}
			onCommit={() => void commitSillyTavernReview()}
		/>
		</>
	);
}
