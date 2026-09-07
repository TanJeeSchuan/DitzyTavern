import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Download, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { expandText } from "../../shared/prompt-macros";
import {
	addPromptPresetInstruction,
	addPromptPresetReference,
	applyConversationCommand,
	duplicatePromptPresetBlock,
	loadConversationPromptPreset,
	movePromptPresetBlock,
	removePromptPresetBlock,
	setPromptPresetBlockContent,
	setPromptPresetBlockEnabled,
	setPromptPresetBlockRole,
	type ConversationPromptPreset,
	type ConversationSummary,
	type PromptBlockReference,
	type PromptOutgoingRole,
	type PromptPresetOperationOutcome,
	type ResolvedPromptPresetSlot,
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
	type PresetCommandOutcome,
	type PromptPresetCommand,
	type PromptPresetSummary,
	type SillyTavernImportPreview,
	type SillyTavernImportRequest,
	type SillyTavernJsonValue,
} from "../prompt-preset-library";
import {
	affectedConversationsLabel,
	presetDeletionConfirmationCopy,
	presetDeletionResultNotice,
	presetSelectionFeedbackLabel,
} from "../prompt-preset-presentation";
import { LIBRARY_UNREACHABLE_NOTICE } from "../lib/command-outcome";
import { useAsyncEffect } from "../lib/use-async";

// ==[HUMAN APPROVED]== The preset editor is a popup rather than a primary panel: the agreed
// exception in the design direction, because a recipe is edited against the
// Chat it assembles for. The library section manages the shared presets and
// the per-Chat selection; ordering and enablement persist immediately through
// their authoritative operations. Referenced source text is read-only here —
// it belongs to the Participant it comes from — while an authored instruction
// block owns its name, text, and outgoing role, each one a per-block draft
// with its own Save and Cancel. The history slot exposes no text or role
// controls at all, because its entries keep the roles of their own Messages.

const slotLabels = {
	"model-system-instruction": "System Instruction",
	"human-identity": "Identity (you)",
	"model-identity": "Identity (character)",
	"model-scenario": "Scenario",
	"model-example-dialogue": "Example Dialogue",
	history: "Chat history",
	"model-post-history-instruction": "Post-History Instruction",
	instruction: "Instruction",
} as const satisfies Record<ResolvedPromptPresetSlot["reference"], string>;

const outgoingRoleLabels = {
	system: "System message",
	user: "User message",
	assistant: "Assistant message",
} as const satisfies Record<PromptOutgoingRole, string>;

const roleSelectClass =
	"rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

// ==[HUMAN APPROVED]== One role-picker surface for both the authored instruction editor and
// the referenced-block outgoing-role row, so the option vocabulary and its
// decode onto the shared contract role live in exactly one place.
const OutgoingRoleSelect = ({
	id,
	value,
	disabled,
	onChange,
}: {
	id: string;
	value: PromptOutgoingRole;
	disabled: boolean;
	onChange: (role: PromptOutgoingRole) => void;
}) => (
	<select
		id={id}
		className={roleSelectClass}
		value={value}
		disabled={disabled}
		onChange={(event) => {
			// ==[HUMAN APPROVED]== The outgoing-role options are exactly the role vocabulary,
			// so the option value decodes onto the shared contract role.
			const role = event.target.value;
			if (role === "system" || role === "user" || role === "assistant") {
				onChange(role);
			}
		}}
	>
		{Object.entries(outgoingRoleLabels).map(([role, label]) => (
			<option key={role} value={role}>{label}</option>
		))}
	</select>
);

const nameInputClass =
	"rounded-lg border border-border bg-background px-2 py-1 font-medium text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const textInputClass =
	"min-h-20 w-full rounded-lg border border-border bg-background px-2 py-1 text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

type PresetView =
	| { status: "loading" }
	| { status: "ready"; presets: PromptPresetSummary[]; selected: ConversationPromptPreset }
	| { status: "unavailable" };

// ==[HUMAN APPROVED]== One inline edit at a time across the whole list: the shape pairs
// the row it belongs to with its draft name, and the kind decides which
// prefill and submit command it carries.
interface PresetInlineEdit {
	id: number;
	kind: "rename" | "duplicate" | "delete";
	name: string;
}

// ==[HUMAN APPROVED]== One block's unsaved draft, keyed by its occurrence id. A referenced
// block drafts only its outgoing role; an authored instruction drafts its
// name, text, and role together because Save persists them as one
// block-level boundary. Ordering and enablement have no draft state: they
// persist immediately through their authoritative operations.
type BlockDraft =
	| { kind: "role"; role: PromptOutgoingRole }
	| { kind: "content"; name: string; content: string; role: PromptOutgoingRole };

// ==[HUMAN APPROVED]== The pending leave a dirty popup must resolve before it may complete:
// closing the popup, or switching to another shared preset. Save persists the
// drafts before completing the action, Discard abandons only those drafts,
// and Keep editing cancels the pending leave.
type LeaveRequest = { kind: "close" } | { kind: "select"; presetId: number };

type SillyTavernReview = {
	request: SillyTavernImportRequest & { source: SillyTavernJsonValue };
	preview: SillyTavernImportPreview;
	orderListId: string | null;
};

type PromptPresetSlotTitleSource =
	| ResolvedPromptPresetSlot
	| SillyTavernImportPreview["native"]["slots"][number];

const slotTitle = (slot: PromptPresetSlotTitleSource): string =>
	slot.reference === "instruction"
		? (slot.name.trim() === "" ? "Instruction" : slot.name)
		: slotLabels[slot.reference];

const SlotBody = ({ slot }: { slot: ResolvedPromptPresetSlot }) => {
	if (slot.reference === "history") {
		return (
			<p className="text-muted-foreground">
				{slot.entryCount === 1
					? "1 Message from the selected narrative path."
					: `${slot.entryCount} Messages from the selected narrative path.`}
			</p>
		);
	}
	if (slot.reference === "instruction") return null;
	if (slot.sourceName === null) {
		return (
			<p className="text-muted-foreground">
				No Participant holds this Control seat yet.
			</p>
		);
	}
	return (
		<>
			<p className="text-muted-foreground">From {slot.sourceName}</p>
			{slot.content === "" ? (
				<p className="text-muted-foreground italic">Empty. Contributes nothing.</p>
			) : (
				<pre className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-2 font-sans whitespace-pre-wrap">
					{slot.content}
				</pre>
			)}
		</>
	);
};

// ==[HUMAN APPROVED]== The number of blocks whose draft differs from the saved recipe state;
// these are the drafts a leave must ask about. A referenced block is dirty
// when its outgoing-role draft differs, an authored instruction when any of
// its name, text, or role differs.
const draftIsDirty = (slot: ResolvedPromptPresetSlot, draft: BlockDraft): boolean => {
	if (slot.reference === "instruction") {
		return draft.kind !== "content"
			? true
			: draft.name !== slot.name ||
				draft.content !== slot.content ||
				draft.role !== slot.role;
	}
	return slot.reference !== "history" && draft.kind === "role" && draft.role !== slot.role;
};

const dirtyDraftCount = (
	preset: ConversationPromptPreset,
	drafts: Record<number, BlockDraft>,
): number =>
	preset.slots.filter((slot) => {
		const draft = drafts[slot.id];
		return draft !== undefined && draftIsDirty(slot, draft);
	}).length;

// ==[HUMAN APPROVED]== The small editor warning previews the shared macro processor's own
// warnings, so the editor and the rendered plan can never disagree about
// which `{{...}}` stays literal. A placeholder context is enough: macro
// recognition is name-based, so `{{self}}` and `{{other}}` never warn here
// and Prompt Comments drop silently exactly as they do in the compiler.
const unknownMacrosOf = (text: string, label: string): string[] => {
	const { warnings } = expandText(text, { self: "", other: "" }, label);
	return [...new Set(warnings.map((warning) => warning.macro))];
};

const AddSlotSelect = ({
	disabled,
	onAdd,
}: {
	disabled: boolean;
	onAdd: (reference: PromptBlockReference) => void;
}) => {
	const [selection, setSelection] = useState<PromptBlockReference | "">("");
	// ==[HUMAN APPROVED]== The add menu offers exactly the reference vocabulary; the
	// authored instruction block has its own add control beside it, because
	// the add-reference command cannot carry authored text.
	const addableLabels = Object.fromEntries(
		Object.entries(slotLabels).filter(([reference]) => reference !== "instruction"),
	);
	const isReference = (value: string): value is PromptBlockReference =>
		Object.hasOwn(addableLabels, value);
	return (
		<>
			<select
				id="prompt-preset-add"
				className={roleSelectClass}
				aria-label="Add a slot to the recipe"
				value={selection}
				disabled={disabled}
				onChange={(event) => {
					const value = event.target.value;
					setSelection(value === "" || isReference(value) ? value : "");
				}}
			>
				<option value="">Choose a reference…</option>
				{Object.entries(addableLabels).map(([reference, label]) => (
					<option key={reference} value={reference}>{label}</option>
				))}
			</select>
			<Button
				size="xs"
				disabled={disabled || selection === ""}
				onClick={() => {
					if (selection === "") return;
					onAdd(selection);
					setSelection("");
				}}
			>
				<Plus aria-hidden="true" />
				Add
			</Button>
		</>
	);
};

// ==[HUMAN APPROVED]== The focused editor for one authored instruction block. Every field is
// a controlled input over the block's draft (or its saved state when clean),
// so nothing reaches another Chat's Generation until Save persists the
// occurrence. Save and Cancel appear only while the draft differs from what
// is stored; Cancel abandons just that draft.
const InstructionFieldEditor = ({
	slot,
	draft,
	disabled,
	onChange,
	onCancel,
	onSave,
}: {
	slot: ResolvedPromptPresetSlot & { reference: "instruction" };
	draft: BlockDraft | undefined;
	disabled: boolean;
	onChange: (fields: { name: string; content: string; role: PromptOutgoingRole }) => void;
	onCancel: () => void;
	onSave: (fields: { name: string; content: string; role: PromptOutgoingRole }) => void;
}) => {
	const fields: { name: string; content: string; role: PromptOutgoingRole } =
		draft?.kind === "content"
			? { name: draft.name, content: draft.content, role: draft.role }
			: { name: slot.name, content: slot.content, role: slot.role };
	const dirty = draft !== undefined && draftIsDirty(slot, draft);
	const warnings = unknownMacrosOf(fields.content, slot.name === "" ? "instruction" : slot.name);
	return (
		<div className="mt-2 flex flex-col gap-2">
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				<span>Name</span>
				<input
					type="text"
					className={nameInputClass}
					value={fields.name}
					disabled={disabled}
					onChange={(event) => onChange({ ...fields, name: event.target.value })}
				/>
			</label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				<span>Instruction text</span>
				<textarea
					className={textInputClass}
					rows={3}
					value={fields.content}
					disabled={disabled}
					placeholder="Write the reusable instruction…"
					onChange={(event) => onChange({ ...fields, content: event.target.value })}
				/>
			</label>
			<div className="flex flex-wrap items-center gap-2">
				<label
					className="text-xs text-muted-foreground"
					htmlFor={`slot-role-${slot.id}`}
				>
					Sent as
				</label>
				<OutgoingRoleSelect
					id={`slot-role-${slot.id}`}
					value={fields.role}
					disabled={disabled}
					onChange={(role) => onChange({ ...fields, role })}
				/>
				{dirty && (
					<>
						<Button size="xs" disabled={disabled} onClick={() => onSave(fields)}>
							Save
						</Button>
						<Button variant="ghost" size="xs" disabled={disabled} onClick={onCancel}>
							Cancel
						</Button>
					</>
				)}
			</div>
			{warnings.length > 0 && (
				<ul className="text-xs text-muted-foreground" role="note">
					{warnings.map((macro) => (
						<li key={macro}>Unknown macro {macro} stays literal.</li>
					))}
				</ul>
			)}
		</div>
	);
};

// ==[HUMAN APPROVED]== The popup's notice wording for the standard Conversation command
// failures. The runner owns when each notice appears; this surface owns what
// it says.
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
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [creating, setCreating] = useState<string | null>(null);
	const [activeEdit, setActiveEdit] = useState<PresetInlineEdit | null>(null);
	// ==[HUMAN APPROVED]== The unsaved block drafts, keyed by the occurrence they belong to.
	// Ordering and enablement have no draft state: they persist immediately
	// through their authoritative operations.
	const [drafts, setDrafts] = useState<Record<number, BlockDraft>>({});
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [leaveRequest, setLeaveRequest] = useState<LeaveRequest | null>(null);
	const [sillyTavernReview, setSillyTavernReview] = useState<SillyTavernReview | null>(null);
	const importInput = useRef<HTMLInputElement>(null);

	const load = async (isCancelled?: () => boolean) => {
		if (conversation === null) {
			setView({ status: "unavailable" });
			return;
		}
		try {
			const [presets, selected] = await Promise.all([
				listPromptPresets(),
				loadConversationPromptPreset(conversation.id),
			]);
			if (isCancelled?.()) return;
			setView(
				selected === null
					? { status: "unavailable" }
					: { status: "ready", presets, selected },
			);
		} catch {
			if (!isCancelled?.()) setView({ status: "unavailable" });
		}
	};

	useAsyncEffect((isCancelled) => {
		if (!open) return;
		// ==[HUMAN APPROVED]== Every open starts clean: transient forms, notices, drafts and
		// pending leaves belong to one popup visit, not to the Chat's lifetime.
		setNotice(null);
		setCreating(null);
		setActiveEdit(null);
		setDrafts({});
		setProblem(null);
		setLeaveRequest(null);
		setSillyTavernReview(null);
		setView({ status: "loading" });
		void load(isCancelled);
	}, [open, conversation]);

	// ==[HUMAN APPROVED]== One library command execution: pending and notice state live
	// here, and the outcome's authoritative re-read refreshes the list and the
	// selected recipe. A success notice is caller-shaped so a rename, a
	// duplication and a deletion each name what happened.
	const runPresetCommand = async (
		action: string,
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => {
		setPendingAction(action);
		setNotice(null);
		try {
			const outcome = await applyPromptPresetCommand(command);
			switch (outcome.status) {
				case "applied":
				case "deleted": {
					await load();
					setNotice(successNotice?.(outcome) ?? null);
					break;
				}
				case "conflict":
					setNotice(`That preset changed elsewhere. It is now "${outcome.currentPreset.name}".`);
					break;
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
			setNotice(LIBRARY_UNREACHABLE_NOTICE);
		} finally {
			setPendingAction(null);
		}
	};

	// ==[HUMAN APPROVED]== Applies one selection through the authoritative Conversation
	// command; `selectPreset` decides whether a pending leave must resolve
	// first.
	const applySelection = (presetId: number) => {
		if (conversation === null) return;
		runConversationCommand({
			revision: () => conversation.revision,
			send: (expectedRevision) =>
				applyConversationCommand(conversation.id, expectedRevision, {
					type: "select-prompt-preset",
					promptPresetId: presetId,
				}),
			reconciliation: {
				adoptSnapshot: onConversationChange,
				showNotice: setNotice,
			},
			notices: PRESET_COMMAND_NOTICES,
			callbacks: {
				onNotPlayable: () => setNotice(PRESET_COMMAND_NOTICES.conflict),
				onNotRemovable: (reason) => setNotice(reason),
				onApplied: async () => {
					setNotice(null);
					await load();
				},
			},
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

	const submitEdit = (preset: PromptPresetSummary, edit: PresetInlineEdit | null) => {
		if (edit === null) return;
		setActiveEdit(null);
		if (edit.kind === "delete") {
			void runPresetCommand(
				"delete",
				{
					type: "delete",
					presetId: preset.id,
					expectedRevision: preset.revision,
				},
				(outcome) =>
					outcome.status === "deleted"
						? presetDeletionResultNotice(preset.name, outcome.result)
						: null,
			);
			return;
		}
		void runPresetCommand(edit.kind, {
			type: edit.kind,
			presetId: preset.id,
			expectedRevision: preset.revision,
			name: edit.name,
		});
	};

	const exportSelectedPreset = async (presetId: number, name: string) => {
		setPendingAction("export");
		setNotice(null);
		try {
			const native = await loadNativePromptPreset(presetId);
			const blob = new Blob([JSON.stringify(native, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${name.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "prompt-preset"}.json`;
			anchor.click();
			URL.revokeObjectURL(url);
			setNotice(`Exported "${name}".`);
		} catch {
			setNotice("The Prompt Preset could not be exported.");
		} finally {
			setPendingAction(null);
		}
	};

	const importPresetFile = async (file: File) => {
		setPendingAction("import");
		setNotice(null);
		try {
			// ==[HUMAN APPROVED]== SAFETY: JSON.parse returns the JSON value that the review route validates again.
			const source = JSON.parse(await file.text()) as SillyTavernJsonValue;
			const native = parseNativePromptPreset(JSON.stringify(source));
			if (native !== null) {
				const outcome = await importNativePromptPreset(native);
				if (outcome.status === "invalid") {
					setNotice(outcome.reason);
					return;
				}
				if (outcome.status === "network") {
					setNotice(LIBRARY_UNREACHABLE_NOTICE);
					return;
				}
				await load();
				setNotice(`Imported "${outcome.preset.name}" as a new preset.`);
				return;
			}
			const review = await reviewSillyTavernPromptPreset(
				source,
				file.name.replace(/\.json$/i, ""),
			);
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
			setNotice("The selected file is not valid Prompt Preset or SillyTavern JSON.");
		} finally {
			setPendingAction(null);
		}
	};

	const commitSillyTavernReview = async () => {
		if (sillyTavernReview === null) return;
		if (sillyTavernReview.preview.requiresOrderSelection && sillyTavernReview.orderListId === null) {
			setNotice("Choose an order list before importing.");
			return;
		}
		setPendingAction("import");
		try {
			const outcome = await commitSillyTavernPromptPreset(
				sillyTavernReview.request.source,
				sillyTavernReview.request.name,
				sillyTavernReview.orderListId ?? undefined,
			);
			if (outcome.status === "invalid") {
				setNotice(outcome.reason);
				return;
			}
			if (outcome.status === "network") {
				setNotice(LIBRARY_UNREACHABLE_NOTICE);
				return;
			}
			setSillyTavernReview(null);
			await load();
			setNotice(`Imported "${outcome.preview.preset.name}" as a new preset.`);
		} finally {
			setPendingAction(null);
		}
	};

	const selectSillyTavernOrder = async (orderListId: string) => {
		if (sillyTavernReview === null) return;
		setPendingAction("review");
		try {
			const outcome = await reviewSillyTavernPromptPreset(
				sillyTavernReview.request.source,
				sillyTavernReview.request.name,
				orderListId,
			);
			if (outcome.status === "review") {
				setSillyTavernReview({ ...sillyTavernReview, preview: outcome.preview, orderListId });
			} else if (outcome.status === "invalid") {
				setNotice(outcome.reason);
			}
		} finally {
			setPendingAction(null);
		}
	};

	// ==[HUMAN APPROVED]== One recipe operation execution: pending and problem state live
	// here, and the applied response's fresh recipe read refreshes the selected
	// recipe while leaving the library list and every other saved change
	// untouched. A draft cannot outlive the occurrence it belongs to. The ready
	// view is only reachable when a Conversation is selected, so its id is
	// always available here.
	const runOperation = async (run: () => Promise<PromptPresetOperationOutcome>) => {
		if (conversation === null) return;
		setPending(true);
		setProblem(null);
		try {
			const outcome = await run();
			if (outcome.status === "invalid") {
				setProblem(outcome.reason);
				return;
			}
			if (outcome.status === "not-found") {
				setProblem("The selected preset no longer exists.");
				return;
			}
			const fresh = await loadConversationPromptPreset(conversation.id);
			if (fresh === null) {
				setView({ status: "unavailable" });
				return;
			}
			const alive = new Set(fresh.slots.map((slot) => slot.id));
			setDrafts(Object.fromEntries(
				Object.entries(drafts).filter(([id]) => alive.has(Number(id))),
			));
			setView((current) =>
				current.status === "ready"
					? { status: "ready", presets: current.presets, selected: fresh }
					: current,
			);
		} finally {
			setPending(false);
		}
	};

	const clearDraft = (blockId: number) =>
		setDrafts(Object.fromEntries(
			Object.entries(drafts).filter(([id]) => Number(id) !== blockId),
		));

	// ==[HUMAN APPROVED]== Saves every dirty block draft through its own narrowly scoped
	// operation, so a leave's Save can never rewrite ordering, toggles, or
	// another block's saved state. Returns null when every draft persisted,
	// else the reason the leave must not complete.
	const saveDrafts = async (preset: ConversationPromptPreset): Promise<string | null> => {
		for (const slot of preset.slots) {
			const draft = drafts[slot.id];
			if (draft === undefined || !draftIsDirty(slot, draft)) continue;
			const outcome = slot.reference === "instruction" && draft.kind === "content"
				? await setPromptPresetBlockContent(preset.id, slot.id, {
					name: draft.name,
					content: draft.content,
					role: draft.role,
				})
				: slot.reference !== "history" && draft.kind === "role"
					? await setPromptPresetBlockRole(preset.id, slot.id, draft.role)
					: null;
			if (outcome !== null && outcome.status !== "applied") {
				return outcome.status === "invalid"
					? outcome.reason
					: "The Prompt Preset change could not be saved.";
			}
		}
		return null;
	};

	// ==[HUMAN APPROVED]== Completes a resolved leave: the drafts are gone, the guard
	// closes, and the deferred action — closing the popup or applying the
	// pending selection — runs.
	const finishLeave = (request: LeaveRequest) => {
		setDrafts({});
		setLeaveRequest(null);
		if (request.kind === "close") {
			onOpenChange(false);
		} else {
			applySelection(request.presetId);
		}
	};

	const ready = view.status === "ready" ? view : null;
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
						<section aria-label="Shared presets" className="flex flex-col gap-2">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<h2 className="text-sm font-medium">Shared presets</h2>
								<div className="flex flex-wrap items-center gap-2">
									<input
										ref={importInput}
										type="file"
										accept="application/json,.json"
										className="sr-only"
										aria-label="Choose native Prompt Preset JSON"
										onChange={(event) => {
											const file = event.target.files?.[0];
											event.target.value = "";
											if (file !== undefined) void importPresetFile(file);
										}}
									/>
									<button
										className="secondary-button"
										type="button"
										disabled={pendingAction !== null}
										onClick={() => importInput.current?.click()}
									>
										<Upload aria-hidden="true" />
										Import JSON
									</button>
									<Button
										variant="outline"
										size="sm"
										disabled={pendingAction !== null}
										onClick={() => void exportSelectedPreset(view.selected.id, view.selected.name)}
									>
										<Download aria-hidden="true" />
										Export JSON
									</Button>
								</div>
							</div>
							<ol className="flex flex-col gap-2">
								{view.presets.map((preset) => (
									<PresetRow
										key={preset.id}
										preset={preset}
										isSelected={preset.id === view.selected.id}
										activeEdit={activeEdit?.id === preset.id ? activeEdit : null}
										pendingAction={pendingAction}
										onEditStart={(kind) =>
											setActiveEdit({
												id: preset.id,
												kind,
												name: kind === "duplicate" ? `Copy of ${preset.name}` : preset.name,
											})
										}
										onEditDraft={(name) =>
											setActiveEdit((current) =>
												current?.id === preset.id ? { ...current, name } : current,
											)
										}
										onEditSubmit={() => submitEdit(preset, activeEdit)}
										onEditCancel={() => setActiveEdit(null)}
										onSelect={() => selectPreset(preset.id)}
									/>
								))}
							</ol>
							{creating === null ? (
								<button
									className="secondary-button justify-self-start"
									type="button"
									disabled={pendingAction !== null}
									onClick={() => setCreating("")}
								>
									New blank preset
								</button>
							) : (
								<InlineNameEdit
									value={creating}
									ariaLabel="New preset name"
									placeholder="Preset name"
									submitLabel="Create"
									busy={pendingAction !== null}
									onChange={setCreating}
									onSubmit={() => {
										const name = creating;
										setCreating(null);
										void runPresetCommand("create", { type: "create", name });
									}}
									onCancel={() => setCreating(null)}
								/>
							)}
						</section>
						<section aria-label="Selected recipe" className="flex flex-col gap-3">
							<h2 className="text-sm font-medium">
								{view.selected.name}: assembled order
							</h2>
							<ol className="flex flex-col gap-3">
								{view.selected.slots.map((slot, index) => {
									const saveInstruction = slot.reference === "instruction"
										? (fields: { name: string; content: string; role: PromptOutgoingRole }) =>
											void runOperation(() =>
												setPromptPresetBlockContent(view.selected.id, slot.id, fields))
										: undefined;
									return (
										<li
											key={slot.id}
											className={`rounded-lg ring-1 ring-foreground/10 p-3${slot.enabled ? "" : " opacity-60"}`}
										>
											<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
												<h3 className="font-medium">
													{index + 1}. {slotTitle(slot)}
												</h3>
												<div className="ml-auto flex items-center gap-1">
													<label className="flex items-center gap-1 text-xs text-muted-foreground">
														<input
															type="checkbox"
															checked={slot.enabled}
															disabled={pending}
															onChange={(event) =>
																void runOperation(() =>
																	setPromptPresetBlockEnabled(
																		view.selected.id,
																		slot.id,
																		event.target.checked,
																	))}
														/>
														Enabled
													</label>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={pending || index === 0}
														aria-label={`Move ${slotTitle(slot)} up`}
														onClick={() => void runOperation(() =>
															movePromptPresetBlock(view.selected.id, slot.id, index))}
													>
														<ChevronUp aria-hidden="true" />
													</Button>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={pending || index === view.selected.slots.length - 1}
														aria-label={`Move ${slotTitle(slot)} down`}
														onClick={() => void runOperation(() =>
															movePromptPresetBlock(view.selected.id, slot.id, index + 2))}
													>
														<ChevronDown aria-hidden="true" />
													</Button>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={pending}
														aria-label={`Duplicate ${slotTitle(slot)}`}
														onClick={() => void runOperation(() =>
															duplicatePromptPresetBlock(view.selected.id, slot.id))}
													>
														<Copy aria-hidden="true" />
													</Button>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={pending}
														aria-label={`Remove ${slotTitle(slot)}`}
														onClick={() => void runOperation(() =>
															removePromptPresetBlock(view.selected.id, slot.id))}
													>
														<Trash2 aria-hidden="true" />
													</Button>
												</div>
											</div>
											{slot.reference === "instruction" ? (
												<InstructionFieldEditor
													slot={slot}
													draft={drafts[slot.id]}
													disabled={pending}
													onChange={(fields) =>
														setDrafts({ ...drafts, [slot.id]: { kind: "content", ...fields } })}
													onCancel={() => clearDraft(slot.id)}
													onSave={(fields) => saveInstruction?.(fields)}
												/>
											) : (
												<>
													<SlotBody slot={slot} />
													{slot.reference !== "history" && (() => {
														const roleDraft = drafts[slot.id];
														const draftRole =
															roleDraft !== undefined && roleDraft.kind === "role"
																? roleDraft.role
																: undefined;
														const dirtyDraft = draftRole !== undefined && draftRole !== slot.role;
														return (
															<div className="mt-2 flex flex-wrap items-center gap-2">
																<label
																	className="text-xs text-muted-foreground"
																	htmlFor={`slot-role-${slot.id}`}
																>
																	Sent as
																</label>
																<OutgoingRoleSelect
																	id={`slot-role-${slot.id}`}
																	value={draftRole ?? slot.role}
																	disabled={pending}
																	onChange={(role) =>
																		setDrafts({ ...drafts, [slot.id]: { kind: "role", role } })}
																/>
																{dirtyDraft && (
																	<>
																		<Button
																			size="xs"
																			disabled={pending}
																			onClick={() => void runOperation(() =>
																				setPromptPresetBlockRole(
																					view.selected.id,
																					slot.id,
																					draftRole,
																				))}
																		>
																			Save
																		</Button>
																		<Button
																			variant="ghost"
																			size="xs"
																			disabled={pending}
																			onClick={() => clearDraft(slot.id)}
																		>
																			Cancel
																		</Button>
																	</>
																)}
															</div>
														);
													})()}
												</>
											)}
										</li>
									);
								})}
								{view.selected.slots.length === 0 && (
									<li className="rounded-lg ring-1 ring-foreground/10 p-3">
										<p className="text-muted-foreground">
											This recipe assembles no context yet. Add a slot below; the Chat
											still generates, but only from its own submitted writing.
										</p>
									</li>
								)}
							</ol>
							{problem !== null && (
								<p className="text-destructive text-sm" role="alert">{problem}</p>
							)}
							<div className="flex flex-wrap items-center gap-2">
								<AddSlotSelect
									disabled={pending}
									onAdd={(reference) =>
										void runOperation(() =>
											addPromptPresetReference(view.selected.id, reference))}
								/>
								<Button
									size="xs"
									disabled={pending}
									onClick={() =>
										void runOperation(() =>
											addPromptPresetInstruction(view.selected.id))}
								>
									<Plus aria-hidden="true" />
									Instruction
								</Button>
							</div>
						</section>
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
							const failure = await saveDrafts(ready.selected);
							if (failure !== null) {
								setProblem(failure);
								setLeaveRequest(null);
								return;
							}
							finishLeave(leaveRequest);
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
		<SillyTavernImportReviewDialog
			review={sillyTavernReview}
			busy={pendingAction !== null}
			onOrderSelect={(orderListId) => void selectSillyTavernOrder(orderListId)}
			onCancel={() => setSillyTavernReview(null)}
			onCommit={() => void commitSillyTavernReview()}
		/>
		</>
	);
}

const importedSlotRole = (
	slot: SillyTavernImportPreview["native"]["slots"][number],
): string => slot.role === null ? "History message roles" : outgoingRoleLabels[slot.role];

function SillyTavernImportReviewDialog({
	review,
	busy,
	onOrderSelect,
	onCancel,
	onCommit,
}: {
	review: SillyTavernReview | null;
	busy: boolean;
	onOrderSelect: (orderListId: string) => void;
	onCancel: () => void;
	onCommit: () => void;
}) {
	return (
		<Dialog open={review !== null} onOpenChange={(next) => { if (!next) onCancel(); }}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Review SillyTavern import</DialogTitle>
					<DialogDescription>
						Review the converted blocks and diagnostics before creating an independent native preset.
					</DialogDescription>
				</DialogHeader>
				{review !== null && (
					<>
						{review.preview.requiresOrderSelection && (
							<label className="flex flex-col gap-1 text-sm">
								<span>Choose an order list</span>
								<select
									className={roleSelectClass}
									value={review.orderListId ?? ""}
									disabled={busy}
									onChange={(event) => onOrderSelect(event.target.value)}
								>
									<option value="">Choose an order…</option>
									{review.preview.orderLists.map((order) => (
										<option key={order.id} value={order.id}>
											{order.label} ({order.entryCount} entries)
										</option>
									))}
								</select>
							</label>
						)}
						<section aria-label="Converted blocks" className="flex flex-col gap-2">
							<h2 className="text-sm font-medium">Converted blocks</h2>
							<ol className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
								{review.preview.native.slots.map((slot, index) => (
									<li key={`${slot.reference}-${index}`} className={slot.enabled ? "" : "opacity-60"}>
										<div className="flex flex-wrap items-baseline gap-x-2">
											<span>{index + 1}. {slotTitle(slot)}{slot.enabled ? "" : " (disabled)"}</span>
											<span className="text-xs text-muted-foreground">{importedSlotRole(slot)}</span>
										</div>
										{slot.reference === "instruction" && (
											<pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs">
												{slot.content || "(empty authored content)"}
											</pre>
										)}
									</li>
								))}
							</ol>
						</section>
						<section aria-label="Import diagnostics" className="flex flex-col gap-1">
							<h2 className="text-sm font-medium">Diagnostics</h2>
							{review.preview.diagnostics.length === 0 ? (
								<p className="text-sm text-muted-foreground">No unsupported behavior was detected.</p>
							) : (
								<ul className="text-sm text-muted-foreground">
									{review.preview.diagnostics.map((item, index) => (
										<li key={`${item.code}-${item.identifier ?? index}`}>{item.message}</li>
									))}
								</ul>
							)}
						</section>
						<div className="flex flex-wrap justify-end gap-2">
							<Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
							<Button
								disabled={busy || review.preview.requiresOrderSelection}
								onClick={onCommit}
							>
								Import as native preset
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

interface PresetRowProps {
	preset: PromptPresetSummary;
	isSelected: boolean;
	activeEdit: PresetInlineEdit | null;
	pendingAction: string | null;
	onEditStart: (kind: PresetInlineEdit["kind"]) => void;
	onEditDraft: (name: string) => void;
	onEditSubmit: () => void;
	onEditCancel: () => void;
	onSelect: () => void;
}

const PresetRow = ({
	preset,
	isSelected,
	activeEdit,
	pendingAction,
	onEditStart,
	onEditDraft,
	onEditSubmit,
	onEditCancel,
	onSelect,
}: PresetRowProps) => {
	const busy = pendingAction !== null;
	const deleteCopy = presetDeletionConfirmationCopy(preset.name, preset.conversationCount);
	return (
		<li className="rounded-lg ring-1 ring-foreground/10 p-3" data-selected={isSelected}>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-medium">
					{preset.name}
					{preset.isDefault && (
						// ==[HUMAN APPROVED]== The leading whitespace keeps the badge a separate
						// accessible name segment, so screen readers never read one fused word.
						<span className="ml-2 text-xs text-muted-foreground"> Default</span>
					)}
				</h3>
				<span className="text-xs text-muted-foreground">
					{affectedConversationsLabel(preset.conversationCount)}
				</span>
			</div>
			{activeEdit === null ? (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{isSelected ? (
						<span className="text-xs font-medium" aria-current="true">
							{presetSelectionFeedbackLabel(true)}
						</span>
					) : (
						<button
							className="secondary-button"
							type="button"
							disabled={busy}
							onClick={onSelect}
						>
							{presetSelectionFeedbackLabel(false)}
						</button>
					)}
					<button
						className="secondary-button"
						type="button"
						disabled={busy}
						onClick={() => onEditStart("rename")}
					>
						Rename
					</button>
					<button
						className="secondary-button"
						type="button"
						disabled={busy}
						onClick={() => onEditStart("duplicate")}
					>
						Duplicate
					</button>
					<button
						className="danger-button"
						type="button"
						disabled={busy}
						onClick={() => onEditStart("delete")}
					>
						Delete
					</button>
				</div>
			) : activeEdit.kind === "delete" ? (
				<div className="mt-2 flex flex-col gap-2">
					<p className="text-sm text-muted-foreground">
						{deleteCopy.impact}
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<button
							className="danger-button"
							type="button"
							disabled={busy}
							onClick={onEditSubmit}
						>
							{deleteCopy.confirmLabel}
						</button>
						<button
							className="secondary-button"
							type="button"
							disabled={busy}
							onClick={onEditCancel}
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="mt-2">
					<InlineNameEdit
						value={activeEdit.name}
						ariaLabel={
							activeEdit.kind === "rename"
								? `Rename ${preset.name}`
								: `Name the copy of ${preset.name}`
						}
						placeholder={activeEdit.kind === "rename" ? "Preset name" : "Copy name"}
						submitLabel={activeEdit.kind === "rename" ? "Save name" : "Duplicate"}
						busy={busy}
						onChange={onEditDraft}
						onSubmit={onEditSubmit}
						onCancel={onEditCancel}
					/>
				</div>
			)}
		</li>
	);
};

const InlineNameEdit = ({
	value,
	ariaLabel,
	placeholder,
	submitLabel,
	busy,
	onChange,
	onSubmit,
	onCancel,
}: {
	value: string;
	ariaLabel: string;
	placeholder?: string;
	submitLabel: string;
	busy: boolean;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) => {
	const ready = value.trim() !== "";
	return (
		<div className="flex flex-wrap items-center gap-2">
			<input
				className="definition-input"
				type="text"
				value={value}
				placeholder={placeholder}
				aria-label={ariaLabel}
				autoFocus
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && ready) onSubmit();
					if (event.key === "Escape") onCancel();
				}}
			/>
			<button
				className="primary-button"
				type="button"
				disabled={busy || !ready}
				onClick={onSubmit}
			>
				{submitLabel}
			</button>
			<button
				className="secondary-button"
				type="button"
				disabled={busy}
				onClick={onCancel}
			>
				Cancel
			</button>
		</div>
	);
};

// ==[HUMAN APPROVED]== The leave guard for a popup with unsaved block edits. Save persists
// every dirty draft through its own operation before completing the requested
// leave; Discard abandons only those drafts; Keep editing cancels the leave
// and keeps the current editor and selection. The wording names whether the
// leave closes the popup or switches presets.
function UnsavedBlockEditDialog({
	open,
	count,
	kind,
	onKeepEditing,
	onDiscard,
	onSave,
}: {
	open: boolean;
	count: number;
	kind: "close" | "select";
	onKeepEditing: () => void;
	onDiscard: () => void;
	onSave: () => Promise<void>;
}) {
	const [saving, setSaving] = useState(false);
	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) onKeepEditing(); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Unsaved block edit{count === 1 ? "" : "s"}</DialogTitle>
					<DialogDescription>
						{count === 1
							? "One block has unsaved text, name or role changes."
							: `${count} blocks have unsaved text, name or role changes.`}
						{" "}Ordering and enablement are already saved.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
					<Button variant="ghost" disabled={saving} onClick={onKeepEditing}>
						Keep editing
					</Button>
					<Button variant="outline" disabled={saving} onClick={onDiscard}>
						Discard
					</Button>
					<Button
						disabled={saving}
						onClick={() => {
							setSaving(true);
							void onSave().finally(() => setSaving(false));
						}}
					>
						{kind === "select" ? "Save and switch" : "Save and close"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
