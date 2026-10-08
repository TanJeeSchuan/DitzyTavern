import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronUp, Copy, GripVertical, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSortable } from "@dnd-kit/react/sortable";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { validateMacroText } from "../../../shared/prompt-macro-engine";
import { isSingleUseReference, type PromptOutgoingRole, type ResolvedPromptPresetSlot } from "../../../shared/contract/prompt-preset";
import {
	duplicatePromptPresetBlock,
	movePromptPresetBlock,
	removePromptPresetBlock,
	type PromptPresetOperationOutcome,
} from "../../prompt-preset-library";
import { outgoingRoleLabels, isPromptOutgoingRole, slotTitle } from "../../prompt-preset-presentation";
import { draftIsDirty, type BlockDraft } from "../../prompt-preset-editor-state";
import { PromptPresetSelect } from "./PromptPresetSelect";

const nameInputClass = "field-input font-normal";
const textInputClass = "field-input min-h-56 max-h-[55vh] resize-y overflow-y-auto leading-relaxed [field-sizing:content]";

const unknownMacrosOf = (text: string, label: string): string[] => {
	const { warnings } = validateMacroText(text, label);
	return [...new Set(warnings.map((warning) => warning.macro))];
};

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
	<PromptPresetSelect
		id={id}
		value={value}
		labels={outgoingRoleLabels}
		isOption={isPromptOutgoingRole}
		disabled={disabled}
		onChange={(role) => {
			if (role !== "") onChange(role);
		}}
	/>
);

type ReferenceSlot = Exclude<ResolvedPromptPresetSlot, { reference: "instruction" }>;
interface ReferenceBlockCopy { description: string; source: string }

const referenceBlockCopy = (slot: ReferenceSlot, title: string): ReferenceBlockCopy => {
	if (slot.reference === "history") {
		return {
			description: "Uses Messages from the selected narrative path.",
			source: "This Chat",
		};
	}
	if (slot.reference === "lore") {
		return {
			description: "Uses Lore Entries admitted when a Generation is assembled.",
			source: "Attached lorebooks",
		};
	}
	if (slot.reference === "memory") {
		return {
			description: "Uses Conversation Memories recalled when a Generation is assembled.",
			source: "Conversation Memories",
		};
	}
	if (slot.reference === "author-note") return { description: "Uses the Author Note saved in this Chat. Edit its text in the Author Note panel.", source: "This Chat" };
	return slot.sourceName === null
		? { description: `No participant is assigned to the ${title}.`, source: "No participant assigned" }
		: { description: `Uses the ${title} from ${slot.sourceName}.`, source: slot.sourceName };
};

const InstructionFieldEditor = ({
	slot,
	draft,
	disabled,
	onChange,
}: {
	slot: ResolvedPromptPresetSlot & { reference: "instruction" };
	draft: BlockDraft | undefined;
	disabled: boolean;
	onChange: (fields: { name: string; content: string; role: PromptOutgoingRole }) => void;
}) => {
	const fields = draft?.kind === "content"
		? { name: draft.name, content: draft.content, role: draft.role }
		: { name: slot.name, content: slot.content, role: slot.role };
	const warnings = unknownMacrosOf(fields.content, slot.name === "" ? "instruction" : slot.name);
	return <div className="flex flex-col gap-3">
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
				rows={8}
				spellCheck={false}
				value={fields.content}
				disabled={disabled}
				placeholder="Write the reusable instruction…"
				onChange={(event) => onChange({ ...fields, content: event.target.value })}
			/>
		</label>
		<div className="flex flex-wrap items-center gap-2">
			<label className="text-xs text-muted-foreground" htmlFor={`slot-role-${slot.id}`}>Sent as</label>
			<OutgoingRoleSelect id={`slot-role-${slot.id}`} value={fields.role} disabled={disabled} onChange={(role) => onChange({ ...fields, role })} />
		</div>
		{warnings.length > 0 && <ul className="text-xs text-muted-foreground" role="note">{warnings.map((macro) => <li key={macro}>Unknown macro {macro} stays literal.</li>)}</ul>}
	</div>;
};

// @approved
//  The draft and operation callbacks a recipe row forwards to its owner; the
// editor section and the row share the contract so they cannot drift.
export interface RecipeOperationHandlers {
	onDraftChange: (blockId: number, draft: BlockDraft) => void;
	onEnabledChange: (blockId: number, enabled: boolean) => void;
	onDraftCancel: (blockId: number) => void;
	onOperation: (run: () => Promise<PromptPresetOperationOutcome>) => void;
}

// @approved
//  One recipe row: the ordered slot header, immediate ordering and drafted toggle
// controls, and a focused modal editor. The draft it shows belongs
// to the occurrence it addresses, so no operation here infers identity from a
// reference.
export function PromptPresetRecipeRow({
	presetId,
	slot,
	index,
	slotCount,
	draft,
	pending,
	autoOpenEditor,
	onAutoOpenEditorHandled,
	onDraftChange,
	onEnabledChange,
	onDraftCancel,
	onOperation,
}: {
	presetId: number;
	slot: ResolvedPromptPresetSlot;
	index: number;
	slotCount: number;
	draft: BlockDraft | undefined;
	pending: boolean;
	autoOpenEditor: boolean;
	onAutoOpenEditorHandled: () => void;
} & RecipeOperationHandlers) {
	const [editing, setEditing] = useState(false);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	useEffect(() => {
		if (!autoOpenEditor) return;
		setConfirmingRemove(false);
		setEditing(true);
		onAutoOpenEditorHandled();
	}, [autoOpenEditor, onAutoOpenEditorHandled]);
	const { ref, handleRef, isDragging, isDropTarget } = useSortable({
		id: slot.id,
		index,
		group: presetId,
		disabled: pending,
	});
	const title = slotTitle(slot);
	const referenceCopy = slot.reference === "instruction" ? null : referenceBlockCopy(slot, title);
	const roleDraft = draft?.kind === "role" ? draft : null;
	const dirty = draft !== undefined && draftIsDirty(slot, draft);
	const enabled = draft?.enabled ?? slot.enabled;
	const closeAndDiscard = (): void => {
		onDraftCancel(slot.id);
		setEditing(false);
	};
	return <li
		ref={ref}
		className={`relative py-2.5 transition-[background-color,box-shadow] motion-reduce:transition-none${
			isDragging
				? " z-10 bg-background shadow-lg ring-1 ring-border"
				: isDropTarget
					? " bg-muted/60"
					: ""
			}`}
	>
		<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
			<div className="flex min-w-0 items-center gap-1">
				<button
					ref={handleRef}
					type="button"
					disabled={pending}
					className={[
					"grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground outline-none",
					"hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing",
				].join(" ")}
					aria-label={`Reorder ${title}`}
				>
					<GripVertical aria-hidden="true" className="size-4" />
				</button>
				<h3 className={`min-w-0 truncate font-medium leading-5${enabled ? "" : " text-muted-foreground"}`}>{title}</h3>
				{dirty && <span className="text-xs text-muted-foreground">Unsaved</span>}
			</div>
			<div className="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon-sm"
					className="border-0 text-muted-foreground"
					disabled={pending}
					title={`Edit ${title}`}
					aria-label={`Edit ${title}`}
					aria-haspopup="dialog"
					onClick={() => {
						setConfirmingRemove(false);
						setEditing(true);
					}}
				>
					<Pencil aria-hidden="true" />
				</Button>
				<Switch checked={enabled} aria-label={`${enabled ? "Disable" : "Enable"} ${title}`} disabled={pending} onCheckedChange={(next) => onEnabledChange(slot.id, next)} />
			</div>
		</div>
		<Dialog open={editing} onOpenChange={setEditing}>
			<DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl">
				<DialogHeader>
					{referenceCopy === null ? (
						<>
							<DialogTitle>Edit prompt block</DialogTitle>
							<DialogDescription>Choose Save in the panel footer to apply these edits.</DialogDescription>
						</>
					) : (
						<>
							<p className="text-xs font-medium text-muted-foreground">Reference block</p>
							<DialogTitle>{title}</DialogTitle>
							<DialogDescription>{referenceCopy.description}</DialogDescription>
						</>
					)}
				</DialogHeader>
				<div className="min-h-0 overflow-y-auto pr-1">
				{slot.reference === "instruction" ? (
					<InstructionFieldEditor
						slot={slot}
						draft={draft}
						disabled={pending}
						onChange={(fields) => onDraftChange(slot.id, { kind: "content", ...fields })}
					/>
				) : (
					<div className="flex flex-col gap-5">
						<dl>
							<dt className="text-xs text-muted-foreground">Source</dt>
							<dd className="mt-1 text-sm font-medium">{referenceCopy?.source}</dd>
						</dl>
						{slot.reference !== "history" && (
							<div className="flex flex-wrap items-center gap-2">
								<label className="text-xs text-muted-foreground" htmlFor={`slot-role-${slot.id}`}>Sent as</label>
								<OutgoingRoleSelect
									id={`slot-role-${slot.id}`}
									value={roleDraft?.role ?? slot.role}
									disabled={pending}
									onChange={(role) => onDraftChange(slot.id, { kind: "role", role })}
								/>
							</div>
						)}
					</div>
				)}
				</div>
				<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
					<div className="flex items-center gap-0.5" role="group" aria-label={`${title} structure actions`}>
						{confirmingRemove ? (
							<>
								<span className="mr-1 text-xs text-muted-foreground">Delete block?</span>
								<Button title="Keep block" variant="ghost" size="icon-sm" disabled={pending} aria-label="Keep block" onClick={() => setConfirmingRemove(false)}><X aria-hidden="true" /></Button>
								<Button
									title="Confirm delete"
									variant="destructive"
									size="icon-sm"
									disabled={pending}
									aria-label={`Delete ${title}`}
									onClick={() => {
										setEditing(false);
										onOperation(() => removePromptPresetBlock(presetId, slot.id));
									}}
									>
										<Trash2 aria-hidden="true" />
									</Button>
							</>
						) : (
							<>
								<Button
									title="Move up"
									variant="ghost"
									size="icon-sm"
									disabled={pending || index === 0}
									aria-label={`Move ${title} up`}
									onClick={() => onOperation(() => movePromptPresetBlock(presetId, slot.id, index))}
									>
										<ChevronUp aria-hidden="true" />
									</Button>
								<Button
									title="Move down"
									variant="ghost"
									size="icon-sm"
									disabled={pending || index === slotCount - 1}
									aria-label={`Move ${title} down`}
									onClick={() => onOperation(() => movePromptPresetBlock(presetId, slot.id, index + 2))}
									>
										<ChevronDown aria-hidden="true" />
									</Button>
								<Button
									title="Duplicate block"
									variant="ghost"
									size="icon-sm"
									disabled={pending || isSingleUseReference(slot.reference)}
									aria-label={`Duplicate ${title}`}
									onClick={() => onOperation(() => duplicatePromptPresetBlock(presetId, slot.id))}
									>
										<Copy aria-hidden="true" />
									</Button>
								<Button
									title="Delete block"
									variant="destructive"
									size="icon-sm"
									disabled={pending}
									aria-label={`Delete ${title}`}
									onClick={() => setConfirmingRemove(true)}
									>
										<Trash2 aria-hidden="true" />
									</Button>
							</>
						)}
					</div>
					<div className="ml-auto flex items-center gap-2">
						<Button title="Cancel" variant="ghost" size="icon-sm" disabled={pending} aria-label="Cancel" onClick={closeAndDiscard}><X aria-hidden="true" /></Button>
						<Button title="Done" size="sm" disabled={pending} onClick={() => setEditing(false)}>Done</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	</li>;
}
