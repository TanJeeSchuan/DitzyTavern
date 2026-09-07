import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	addPromptPresetReference,
	applyConversationCommand,
	duplicatePromptPresetBlock,
	loadConversationPromptPreset,
	movePromptPresetBlock,
	removePromptPresetBlock,
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
// Chat it assembles for. The library section manages the shared presets and
// the per-Chat selection; ordering and enablement persist immediately through
// their authoritative operations, a Definition slot's outgoing role is a
// per-block draft with its own Save and Cancel, and referenced source text is
// read-only here — it belongs to the Participant it comes from. The history
// slot exposes no text or role controls at all, because its entries keep the
// roles of their own Messages.

const slotLabels = {
	"model-system-instruction": "System Instruction",
	"human-identity": "Identity (you)",
	"model-identity": "Identity (character)",
	"model-scenario": "Scenario",
	"model-example-dialogue": "Example Dialogue",
	history: "Chat history",
	"model-post-history-instruction": "Post-History Instruction",
} as const satisfies Record<ResolvedPromptPresetSlot["reference"], string>;

const outgoingRoleLabels = {
	system: "System message",
	user: "User message",
	assistant: "Assistant message",
} as const satisfies Record<PromptOutgoingRole, string>;

const roleSelectClass =
	"rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

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

// ==[HUMAN APPROVED]== The number of Definition occurrences whose outgoing-role draft differs
// from the saved recipe state; these are the drafts a close must ask about.
const savedRoleOf = (slot: ResolvedPromptPresetSlot): PromptOutgoingRole | undefined =>
	slot.reference === "history" ? undefined : slot.role;

const dirtyDraftCount = (
	preset: ConversationPromptPreset,
	drafts: Record<number, PromptOutgoingRole>,
): number =>
	preset.slots.filter((slot) => {
		const draft = drafts[slot.id];
		return draft !== undefined && draft !== savedRoleOf(slot);
	}).length;

const AddSlotSelect = ({
	disabled,
	onAdd,
}: {
	disabled: boolean;
	onAdd: (reference: PromptBlockReference) => void;
}) => {
	const [selection, setSelection] = useState<PromptBlockReference | "">("");
	// ==[HUMAN APPROVED]== The add menu offers exactly the reference vocabulary, so the
	// selected option value decodes onto the shared contract type at this
	// boundary.
	const isReference = (value: string): value is PromptBlockReference =>
		Object.hasOwn(slotLabels, value);
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
				{Object.entries(slotLabels).map(([reference, label]) => (
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
	// ==[HUMAN APPROVED]== The unsaved outgoing-role drafts, keyed by the block occurrence
	// they belong to. Ordering and enablement have no draft state: they
	// persist immediately through their authoritative operations.
	const [drafts, setDrafts] = useState<Record<number, PromptOutgoingRole>>({});
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [confirmClose, setConfirmClose] = useState(false);

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
		// ==[HUMAN APPROVED]== Every open starts clean: transient forms, notices and drafts
		// belong to one popup visit, not to the Chat's lifetime.
		setNotice(null);
		setCreating(null);
		setActiveEdit(null);
		setDrafts({});
		setProblem(null);
		setConfirmClose(false);
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

	const ready = view.status === "ready" ? view : null;
	const dirty =
		ready !== null &&
		ready.selected.slots.some((slot) => {
			const draft = drafts[slot.id];
			return draft !== undefined && draft !== savedRoleOf(slot);
		});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && dirty) {
					setConfirmClose(true);
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
						setConfirmClose(true);
					}
				}}
				onInteractOutside={(event) => {
					if (dirty) {
						event.preventDefault();
						setConfirmClose(true);
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
						edited on the Participant it comes from.
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
								{view.selected.slots.map((slot, index) => {
									const draft = slot.reference === "history" ? undefined : drafts[slot.id];
									const savedRole = savedRoleOf(slot);
									const dirtyDraft = draft !== undefined && draft !== savedRole;
									return (
										<li
											key={slot.id}
											className={`rounded-lg ring-1 ring-foreground/10 p-3${slot.enabled ? "" : " opacity-60"}`}
										>
											<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
												<h3 className="font-medium">
													{index + 1}. {slotLabels[slot.reference]}
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
														aria-label={`Move ${slotLabels[slot.reference]} up`}
														onClick={() => void runOperation(() =>
															movePromptPresetBlock(view.selected.id, slot.id, index))}
													>
														<ChevronUp aria-hidden="true" />
													</Button>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={pending || index === view.selected.slots.length - 1}
														aria-label={`Move ${slotLabels[slot.reference]} down`}
														onClick={() => void runOperation(() =>
															movePromptPresetBlock(view.selected.id, slot.id, index + 2))}
													>
														<ChevronDown aria-hidden="true" />
													</Button>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={pending}
														aria-label={`Duplicate ${slotLabels[slot.reference]}`}
														onClick={() => void runOperation(() =>
															duplicatePromptPresetBlock(view.selected.id, slot.id))}
													>
														<Copy aria-hidden="true" />
													</Button>
													<Button
														variant="ghost"
														size="icon-sm"
														disabled={pending}
														aria-label={`Remove ${slotLabels[slot.reference]}`}
														onClick={() => void runOperation(() =>
															removePromptPresetBlock(view.selected.id, slot.id))}
													>
														<Trash2 aria-hidden="true" />
													</Button>
												</div>
											</div>
											<SlotBody slot={slot} />
											{slot.reference !== "history" && (
												<div className="mt-2 flex flex-wrap items-center gap-2">
													<label
														className="text-xs text-muted-foreground"
														htmlFor={`slot-role-${slot.id}`}
													>
														Sent as
													</label>
													<select
														id={`slot-role-${slot.id}`}
														className={roleSelectClass}
														value={draft ?? savedRole}
														disabled={pending}
														onChange={(event) => {
															// ==[HUMAN APPROVED]== The outgoing-role options are exactly the role
															// vocabulary, so the option value decodes onto the shared
															// contract role.
															const role = event.target.value;
															if (role === "system" || role === "user" || role === "assistant") {
																setDrafts({ ...drafts, [slot.id]: role });
															}
														}}
													>
														{Object.entries(outgoingRoleLabels).map(([role, label]) => (
															<option key={role} value={role}>{label}</option>
														))}
													</select>
													{dirtyDraft && (
														<>
															<Button
																size="xs"
																disabled={pending}
																onClick={() => void runOperation(() =>
																	setPromptPresetBlockRole(
																		view.selected.id,
																		slot.id,
																		draft,
																	))}
															>
																Save
															</Button>
															<Button
																variant="ghost"
																size="xs"
																disabled={pending}
																onClick={() => setDrafts(Object.fromEntries(
																	Object.entries(drafts).filter(([id]) => Number(id) !== slot.id),
																))}
															>
																Cancel
															</Button>
														</>
													)}
												</div>
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
							</div>
						</section>
					</>
				)}
				{notice !== null && (
					<p className="text-sm text-muted-foreground" role="status">
						{notice}
					</p>
				)}
				{ready !== null && (
					<UnsavedRoleDraftDialog
						open={confirmClose}
						count={dirtyDraftCount(ready.selected, drafts)}
						onKeepEditing={() => setConfirmClose(false)}
						onDiscard={() => {
							setDrafts({});
							setConfirmClose(false);
							onOpenChange(false);
						}}
						onSave={async () => {
							const dirtySlots = ready.selected.slots.flatMap((slot) => {
								const draft = drafts[slot.id];
								return draft !== undefined && draft !== savedRoleOf(slot)
									? [[slot, draft] as const]
									: [];
							});
							for (const [slot, draft] of dirtySlots) {
								const outcome = await setPromptPresetBlockRole(
									ready.selected.id,
									slot.id,
									draft,
								);
								if (outcome.status === "invalid") {
									setProblem(outcome.reason);
									setConfirmClose(false);
									return;
								}
							}
							setDrafts({});
							setConfirmClose(false);
							onOpenChange(false);
						}}
					/>
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

function UnsavedRoleDraftDialog({
	open,
	count,
	onKeepEditing,
	onDiscard,
	onSave,
}: {
	open: boolean;
	count: number;
	onKeepEditing: () => void;
	onDiscard: () => void;
	onSave: () => Promise<void>;
}) {
	const [saving, setSaving] = useState(false);
	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) onKeepEditing(); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Unsaved role change{count === 1 ? "" : "s"}</DialogTitle>
					<DialogDescription>
						{count === 1
							? "One referenced block has an unsaved outgoing role."
							: `${count} referenced blocks have unsaved outgoing roles.`}
						Ordering and enablement are already saved.
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
						Save and close
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
