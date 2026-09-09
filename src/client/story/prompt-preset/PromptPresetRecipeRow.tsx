import { ChevronDown, ChevronUp, Copy, GripVertical, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { expandText } from "../../../shared/prompt-macros";
import type { PromptOutgoingRole, ResolvedPromptPresetSlot } from "../../../shared/contract/prompt-preset";
import {
	duplicatePromptPresetBlock,
	movePromptPresetBlock,
	removePromptPresetBlock,
	savePromptPresetBlockPatches,
	setPromptPresetBlockEnabled,
	type PromptPresetOperationOutcome,
} from "../../prompt-preset-library";
import { outgoingRoleLabels, isPromptOutgoingRole, slotTitle } from "../../prompt-preset-presentation";
import { draftIsDirty, draftToPatch, type BlockDraft } from "../../prompt-preset-editor-state";
import { PromptPresetSelect } from "./PromptPresetSelect";

const nameInputClass = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const textInputClass = "min-h-56 max-h-[55vh] w-full resize-y overflow-y-auto rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none [field-sizing:content] focus-visible:ring-3 focus-visible:ring-ring/50";

const unknownMacrosOf = (text: string, label: string): string[] => {
	const { warnings } = expandText(text, { self: "", other: "" }, label);
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

const SlotBody = ({ slot }: { slot: ResolvedPromptPresetSlot }) => {
	if (slot.reference === "history") {
		return <p className="mt-1 text-sm text-muted-foreground">{slot.entryCount === 1 ? "1 Message from the selected narrative path." : `${slot.entryCount} Messages from the selected narrative path.`}</p>;
	}
	if (slot.reference === "instruction") return null;
	if (slot.sourceName === null) return <p className="mt-1 text-sm text-muted-foreground">No Participant holds this Control seat yet.</p>;
	return <>
		<p className="mt-1 text-sm text-muted-foreground">From {slot.sourceName}</p>
		{slot.content === "" ? <p className="text-sm text-muted-foreground">No prompt text.</p> : <pre className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-2 font-sans text-sm whitespace-pre-wrap">{slot.content}</pre>}
	</>;
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
		<label className="flex flex-col gap-1 text-xs text-muted-foreground"><span>Name</span><input type="text" className={nameInputClass} value={fields.name} disabled={disabled} onChange={(event) => onChange({ ...fields, name: event.target.value })} /></label>
		<label className="flex flex-col gap-1 text-xs text-muted-foreground"><span>Instruction text</span><textarea className={textInputClass} rows={8} spellCheck={false} value={fields.content} disabled={disabled} placeholder="Write the reusable instruction…" onChange={(event) => onChange({ ...fields, content: event.target.value })} /></label>
		<div className="flex flex-wrap items-center gap-2">
			<label className="text-xs text-muted-foreground" htmlFor={`slot-role-${slot.id}`}>Sent as</label>
			<OutgoingRoleSelect id={`slot-role-${slot.id}`} value={fields.role} disabled={disabled} onChange={(role) => onChange({ ...fields, role })} />
		</div>
		{warnings.length > 0 && <ul className="text-xs text-muted-foreground" role="note">{warnings.map((macro) => <li key={macro}>Unknown macro {macro} stays literal.</li>)}</ul>}
	</div>;
};

// ==[HUMAN APPROVED]== The draft and operation callbacks a recipe row forwards to its owner; the
// editor section and the row share the contract so they cannot drift.
export interface RecipeOperationHandlers {
	onDraftChange: (blockId: number, draft: BlockDraft) => void;
	onDraftCancel: (blockId: number) => void;
	onOperation: (
		run: () => Promise<PromptPresetOperationOutcome>,
		submitted?: { blockId: number; draft: BlockDraft },
	) => void;
}

// ==[HUMAN APPROVED]== A block's Save submits exactly the occurrence-addressed patch the one
// slot-kind-safe draft-to-patch rule derives from the slot and its draft, so per-block Save and
// the save-on-leave batch can never construct different patches for the same draft.
const saveDraftPatch = (
	presetId: number,
	slot: ResolvedPromptPresetSlot,
	draft: BlockDraft,
	onOperation: RecipeOperationHandlers["onOperation"],
): void => {
	const patch = draftToPatch(slot, draft);
	if (patch === null) return;
	onOperation(() => savePromptPresetBlockPatches(presetId, [patch]), { blockId: slot.id, draft });
};

// ==[HUMAN APPROVED]== One recipe row: the ordered slot header, immediate ordering and toggle
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
	onDraftChange,
	onDraftCancel,
	onOperation,
}: {
	presetId: number;
	slot: ResolvedPromptPresetSlot;
	index: number;
	slotCount: number;
	draft: BlockDraft | undefined;
	pending: boolean;
} & RecipeOperationHandlers) {
	const [editing, setEditing] = useState(false);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const title = slotTitle(slot);
	const roleDraft = draft?.kind === "role" ? draft : null;
	const dirty = draft !== undefined && draftIsDirty(slot, draft);
	const closeAndDiscard = (): void => {
		onDraftCancel(slot.id);
		setEditing(false);
	};
	const saveAndClose = (): void => {
		if (draft !== undefined) saveDraftPatch(presetId, slot, draft, onOperation);
		setEditing(false);
	};
	const actions = <div className="flex items-center gap-0.5" role="group" aria-label={`${title} actions`}>
		<Button title="Move up" variant="ghost" size="icon-sm" disabled={pending || index === 0} aria-label={`Move ${title} up`} onClick={() => onOperation(() => movePromptPresetBlock(presetId, slot.id, index))}><ChevronUp aria-hidden="true" /></Button>
		<Button title="Move down" variant="ghost" size="icon-sm" disabled={pending || index === slotCount - 1} aria-label={`Move ${title} down`} onClick={() => onOperation(() => movePromptPresetBlock(presetId, slot.id, index + 2))}><ChevronDown aria-hidden="true" /></Button>
		<Button title="Duplicate block" variant="ghost" size="icon-sm" disabled={pending} aria-label={`Duplicate ${title}`} onClick={() => onOperation(() => duplicatePromptPresetBlock(presetId, slot.id))}><Copy aria-hidden="true" /></Button>
		{confirmingRemove ? (
			<div className="ml-3 flex items-center gap-2 border-l border-border pl-3">
				<span className="text-xs text-muted-foreground">Remove this block?</span>
				<Button variant="destructive" size="xs" disabled={pending} onClick={() => { setEditing(false); onOperation(() => removePromptPresetBlock(presetId, slot.id)); }}>Remove</Button>
				<Button variant="ghost" size="xs" disabled={pending} onClick={() => setConfirmingRemove(false)}>Keep</Button>
			</div>
		) : (
			<div className="ml-3 border-l border-border pl-3">
				<Button title="Remove block" variant="destructive" size="icon-sm" disabled={pending} aria-label={`Remove ${title}`} onClick={() => setConfirmingRemove(true)}><Trash2 aria-hidden="true" /></Button>
			</div>
		)}
	</div>;
	return <li
		className={`py-2.5${slot.enabled ? "" : " opacity-60"}`}
		onDragOver={(event) => event.preventDefault()}
		onDrop={(event) => {
			const sourceId = Number(event.dataTransfer.getData("application/x-ditzy-prompt-slot"));
			if (Number.isSafeInteger(sourceId) && sourceId !== slot.id) {
				onOperation(() => movePromptPresetBlock(presetId, sourceId, index + 1));
			}
		}}
	>
		<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
			<div className="flex min-w-0 items-center gap-1">
				<button
					type="button"
					draggable={!pending}
					disabled={pending}
					className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing"
					aria-label={`Reorder ${title}. Use the arrow keys or drag.`}
					onDragStart={(event) => {
						event.dataTransfer.effectAllowed = "move";
						event.dataTransfer.setData("application/x-ditzy-prompt-slot", String(slot.id));
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowUp" && index > 0) {
							event.preventDefault();
							onOperation(() => movePromptPresetBlock(presetId, slot.id, index));
						}
						if (event.key === "ArrowDown" && index < slotCount - 1) {
							event.preventDefault();
							onOperation(() => movePromptPresetBlock(presetId, slot.id, index + 2));
						}
					}}
				>
					<GripVertical aria-hidden="true" className="size-4" />
				</button>
				<h3 className="min-w-0 truncate font-medium leading-5">{title}</h3>
			</div>
			<div className="flex items-center gap-1">
				<Button
					variant="ghost"
					size="xs"
					disabled={pending}
					aria-haspopup="dialog"
					onClick={() => {
						setConfirmingRemove(false);
						setEditing(true);
					}}
				>
					<Pencil aria-hidden="true" />
					Edit
				</Button>
				<button
					type="button"
					role="switch"
					aria-checked={slot.enabled}
					aria-label={`${slot.enabled ? "Disable" : "Enable"} ${title}`}
					disabled={pending}
					className={`relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${slot.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
					onClick={() => onOperation(() => setPromptPresetBlockEnabled(presetId, slot.id, !slot.enabled))}
				>
					<span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow-sm transition-transform ${slot.enabled ? "translate-x-4" : "translate-x-0"}`} />
				</button>
			</div>
		</div>
		<Dialog open={editing} onOpenChange={(open) => { if (open || !dirty) setEditing(open); }}>
			<DialogContent showCloseButton={!dirty} className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{slot.reference === "instruction" ? "Edit prompt block" : `Edit ${title}`}</DialogTitle>
					<DialogDescription>
						{slot.reference === "history"
							? "This block has no editable fields. Use the actions below to manage it."
							: <>Changes are applied only when you choose Save &amp; Close.</>}
					</DialogDescription>
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
					<div className="flex flex-col gap-3">
						<SlotBody slot={slot} />
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
				<div className="flex items-center justify-between border-t border-border pt-3">
					{actions}
					{dirty && (
						<div className="ml-auto flex items-center gap-2">
							<Button variant="ghost" size="sm" disabled={pending} onClick={closeAndDiscard}>Cancel</Button>
							<Button size="sm" disabled={pending} onClick={saveAndClose}>Save &amp; Close</Button>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	</li>;
}
