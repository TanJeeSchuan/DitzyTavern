import { useState } from "react";
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
	type ResolvedPromptPresetSlot,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	applyPromptPresetCommand,
	listPromptPresets,
	type PresetCommandOutcome,
	type PromptPresetCommand,
	type PromptPresetSummary,
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
// Chat it assembles for. The library section manages the shared presets;
// ordering, toggles and authored blocks arrive with the editor tickets, so
// the recipe display stays read-only for now.

const slotLabels = {
	"model-system-instruction": "System Instruction",
	"human-identity": "Identity (you)",
	"model-identity": "Identity (character)",
	"model-scenario": "Scenario",
	"model-example-dialogue": "Example Dialogue",
	history: "Chat history",
	"model-post-history-instruction": "Post-History Instruction",
} as const satisfies Record<ResolvedPromptPresetSlot["reference"], string>;

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
		// ==[HUMAN APPROVED]== Every open starts clean: transient forms and notices belong
		// to one popup visit, not to the Chat's lifetime.
		setNotice(null);
		setCreating(null);
		setActiveEdit(null);
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

	const selectPreset = (presetId: number) => {
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

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{view.status === "ready"
							? `Prompt Preset: ${view.selected.name}`
							: "Prompt Preset"}
					</DialogTitle>
					<DialogDescription>
						Shared recipes live in one library and each Chat selects one. The
						order below is what this Chat assembles its writing context in;
						referenced content is read-only here.
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
							<h2 className="text-sm font-medium">Shared presets</h2>
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
								{view.selected.slots.map((slot, index) => (
									<li
										key={`${slot.reference}-${index}`}
										className="rounded-lg ring-1 ring-foreground/10 p-3"
										data-enabled={slot.enabled}
									>
										<div className="flex items-baseline justify-between gap-2">
											<h3 className="font-medium">
												{index + 1}. {slotLabels[slot.reference]}
											</h3>
											<span className="text-xs text-muted-foreground">
												{slot.enabled ? "Enabled" : "Disabled"}
											</span>
										</div>
										<SlotBody slot={slot} />
									</li>
								))}
							</ol>
						</section>
					</>
				)}
				{notice !== null && (
					<p className="text-sm text-muted-foreground" role="status">
						{notice}
					</p>
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
