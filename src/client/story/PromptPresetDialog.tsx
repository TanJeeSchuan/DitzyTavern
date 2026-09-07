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
	duplicatePromptPresetBlock,
	loadConversationPromptPreset,
	movePromptPresetBlock,
	removePromptPresetBlock,
	setPromptPresetBlockEnabled,
	setPromptPresetBlockRole,
	type ConversationPromptPreset,
	type PromptBlockReference,
	type PromptOutgoingRole,
	type PromptPresetOperationOutcome,
	type ResolvedPromptPresetSlot,
} from "../conversation";
import { useAsyncEffect } from "../lib/use-async";

// ==[HUMAN APPROVED]== The preset editor is a popup rather than a primary panel: the agreed
// exception in the design direction, because a recipe is edited against the
// Chat it assembles for. Ordering and enablement persist immediately through
// their authoritative operations; a Definition slot's outgoing role is a
// per-block draft with its own Save and Cancel. Referenced source text is
// read-only here — it belongs to the Participant it comes from — and the
// history slot exposes no text or role controls at all, because its entries
// keep the roles of their own Messages.

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

type PresetView =
	| { status: "loading" }
	| { status: "ready"; preset: ConversationPromptPreset }
	| { status: "unavailable" };

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

export function PromptPresetDialog({
	conversationId,
	open,
	onOpenChange,
}: {
	conversationId: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [view, setView] = useState<PresetView>({ status: "loading" });
	// ==[HUMAN APPROVED]== The unsaved outgoing-role drafts, keyed by the block occurrence
	// they belong to. Ordering and enablement have no draft state: they
	// persist immediately through their authoritative operations.
	const [drafts, setDrafts] = useState<Record<number, PromptOutgoingRole>>({});
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [confirmClose, setConfirmClose] = useState(false);

	useAsyncEffect(
		async (isCancelled) => {
			if (!open) return;
			setView({ status: "loading" });
			try {
				const preset = await loadConversationPromptPreset(conversationId);
				if (isCancelled()) return;
				setView(
					preset === null
						? { status: "unavailable" }
						: { status: "ready", preset },
				);
			} catch {
				if (!isCancelled()) setView({ status: "unavailable" });
			}
		},
		[conversationId, open],
	);

	if (view.status !== "ready") {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Prompt Preset</DialogTitle>
						<DialogDescription>
							The order this Chat assembles its writing context in. Referenced
							content is read-only here; edit it on the Participant it comes from.
						</DialogDescription>
					</DialogHeader>
					{view.status === "loading" && (
						<div role="status">
							<span className="sr-only">Loading the selected preset…</span>
							<ol aria-hidden="true" className="flex flex-col gap-3">
								{Array.from({ length: 4 }, (_, index) => (
									<li
										key={index}
										className="h-20 animate-pulse rounded-lg bg-muted/50 ring-1 ring-foreground/10"
									/>
								))}
							</ol>
						</div>
					)}
					{view.status === "unavailable" && (
						<p className="text-muted-foreground">
							The selected preset could not be loaded.
						</p>
					)}
				</DialogContent>
			</Dialog>
		);
	}

	const preset = view.preset;
	const dirty = preset.slots.some((slot) => {
		const draft = drafts[slot.id];
		return draft !== undefined && draft !== savedRoleOf(slot);
	});

	const runOperation = async (run: () => Promise<PromptPresetOperationOutcome>) => {
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
			const fresh = await loadConversationPromptPreset(conversationId);
			if (fresh === null) {
				setView({ status: "unavailable" });
				return;
			}
			// ==[HUMAN APPROVED]== A draft cannot outlive the occurrence it belongs to.
			const alive = new Set(fresh.slots.map((slot) => slot.id));
			setDrafts(Object.fromEntries(
				Object.entries(drafts).filter(([id]) => alive.has(Number(id))),
			));
			setView({ status: "ready", preset: fresh });
		} finally {
			setPending(false);
		}
	};

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
					<DialogTitle>Prompt Preset: {preset.name}</DialogTitle>
					<DialogDescription>
						The order this Chat assembles its writing context in. Ordering and
						enablement save immediately; referenced content is read-only here,
						edited on the Participant it comes from.
					</DialogDescription>
				</DialogHeader>
				<ol className="flex flex-col gap-3">
					{preset.slots.map((slot, index) => {
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
															preset.id,
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
												movePromptPresetBlock(preset.id, slot.id, index))}
										>
											<ChevronUp aria-hidden="true" />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={pending || index === preset.slots.length - 1}
											aria-label={`Move ${slotLabels[slot.reference]} down`}
											onClick={() => void runOperation(() =>
												movePromptPresetBlock(preset.id, slot.id, index + 2))}
										>
											<ChevronDown aria-hidden="true" />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={pending}
											aria-label={`Duplicate ${slotLabels[slot.reference]}`}
											onClick={() => void runOperation(() =>
												duplicatePromptPresetBlock(preset.id, slot.id))}
										>
											<Copy aria-hidden="true" />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											disabled={pending}
											aria-label={`Remove ${slotLabels[slot.reference]}`}
											onClick={() => void runOperation(() =>
												removePromptPresetBlock(preset.id, slot.id))}
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
														setPromptPresetBlockRole(preset.id, slot.id, draft))}
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
					{preset.slots.length === 0 && (
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
							void runOperation(() => addPromptPresetReference(preset.id, reference))}
					/>
				</div>
				<UnsavedRoleDraftDialog
					open={confirmClose}
					count={dirtyDraftCount(preset, drafts)}
					onKeepEditing={() => setConfirmClose(false)}
					onDiscard={() => {
						setDrafts({});
						setConfirmClose(false);
						onOpenChange(false);
					}}
					onSave={async () => {
						const dirtySlots = preset.slots.flatMap((slot) => {
							const draft = drafts[slot.id];
							return draft !== undefined && draft !== savedRoleOf(slot)
								? [[slot, draft] as const]
								: [];
						});
						for (const [slot, draft] of dirtySlots) {
							const outcome = await setPromptPresetBlockRole(
								preset.id,
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
			</DialogContent>
		</Dialog>
	);
}

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
