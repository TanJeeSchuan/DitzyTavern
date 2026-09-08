import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { expandText } from "../../../shared/prompt-macros";
import {
	addPromptPresetInstruction,
	addPromptPresetReference,
	duplicatePromptPresetBlock,
	movePromptPresetBlock,
	removePromptPresetBlock,
	setPromptPresetBlockContent,
	setPromptPresetBlockEnabled,
	setPromptPresetBlockRole,
	type ConversationPromptPreset,
	type PromptBlockReference,
	type PromptOutgoingRole,
	type PromptPresetOperationOutcome,
	type ResolvedPromptPresetSlot,
} from "../../conversation";

export type BlockDraft =
	| { kind: "role"; role: PromptOutgoingRole }
	| { kind: "content"; name: string; content: string; role: PromptOutgoingRole };

export const draftIsDirty = (slot: ResolvedPromptPresetSlot, draft: BlockDraft): boolean => {
	if (slot.reference === "instruction") {
		return draft.kind !== "content"
			? true
			: draft.name !== slot.name || draft.content !== slot.content || draft.role !== slot.role;
	}
	return slot.reference !== "history" && draft.kind === "role" && draft.role !== slot.role;
};

export const dirtyDraftCount = (
	preset: ConversationPromptPreset,
	drafts: Record<number, BlockDraft>,
): number => preset.slots.filter((slot) => {
	const draft = drafts[slot.id];
	return draft !== undefined && draftIsDirty(slot, draft);
}).length;

// ==[HUMAN APPROVED]== A save finishes exactly the submitted draft version: after a
// successful save the editor retires an occurrence's draft only when it still
// equals what was submitted, so a newer local edit made while saving survives.
export const blockDraftEquals = (a: BlockDraft, b: BlockDraft): boolean => {
	if (a.kind === "role") return b.kind === "role" && a.role === b.role;
	return b.kind === "content" && a.name === b.name && a.content === b.content && a.role === b.role;
};

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

const roleSelectClass = "rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const nameInputClass = "rounded-lg border border-border bg-background px-2 py-1 font-medium text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const textInputClass = "min-h-20 w-full rounded-lg border border-border bg-background px-2 py-1 text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const slotTitle = (slot: ResolvedPromptPresetSlot): string =>
	slot.reference === "instruction"
		? (slot.name.trim() === "" ? "Instruction" : slot.name)
		: slotLabels[slot.reference];

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
	<select
		id={id}
		className={roleSelectClass}
		value={value}
		disabled={disabled}
		onChange={(event) => {
			const role = event.target.value;
			if (role === "system" || role === "user" || role === "assistant") onChange(role);
		}}
	>
		{Object.entries(outgoingRoleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
	</select>
);

const AddSlotSelect = ({
	disabled,
	onAdd,
}: {
	disabled: boolean;
	onAdd: (reference: PromptBlockReference) => void;
}) => {
	const [selection, setSelection] = useState<PromptBlockReference | "">("");
	const addableLabels = Object.fromEntries(Object.entries(slotLabels).filter(([reference]) => reference !== "instruction"));
	const isReference = (value: string): value is PromptBlockReference => Object.hasOwn(addableLabels, value);
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
				{Object.entries(addableLabels).map(([reference, label]) => <option key={reference} value={reference}>{label}</option>)}
			</select>
			<Button size="xs" disabled={disabled || selection === ""} onClick={() => {
				if (selection === "") return;
				onAdd(selection);
				setSelection("");
			}}> <Plus aria-hidden="true" /> Add</Button>
		</>
	);
};

const SlotBody = ({ slot }: { slot: ResolvedPromptPresetSlot }) => {
	if (slot.reference === "history") {
		return <p className="text-muted-foreground">{slot.entryCount === 1 ? "1 Message from the selected narrative path." : `${slot.entryCount} Messages from the selected narrative path.`}</p>;
	}
	if (slot.reference === "instruction") return null;
	if (slot.sourceName === null) return <p className="text-muted-foreground">No Participant holds this Control seat yet.</p>;
	return <>
		<p className="text-muted-foreground">From {slot.sourceName}</p>
		{slot.content === "" ? <p className="text-muted-foreground italic">Empty. Contributes nothing.</p> : <pre className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-2 font-sans whitespace-pre-wrap">{slot.content}</pre>}
	</>;
};

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
	const fields = draft?.kind === "content"
		? { name: draft.name, content: draft.content, role: draft.role }
		: { name: slot.name, content: slot.content, role: slot.role };
	const dirty = draft !== undefined && draftIsDirty(slot, draft);
	const warnings = unknownMacrosOf(fields.content, slot.name === "" ? "instruction" : slot.name);
	return <div className="mt-2 flex flex-col gap-2">
		<label className="flex flex-col gap-1 text-xs text-muted-foreground"><span>Name</span><input type="text" className={nameInputClass} value={fields.name} disabled={disabled} onChange={(event) => onChange({ ...fields, name: event.target.value })} /></label>
		<label className="flex flex-col gap-1 text-xs text-muted-foreground"><span>Instruction text</span><textarea className={textInputClass} rows={3} value={fields.content} disabled={disabled} placeholder="Write the reusable instruction…" onChange={(event) => onChange({ ...fields, content: event.target.value })} /></label>
		<div className="flex flex-wrap items-center gap-2">
			<label className="text-xs text-muted-foreground" htmlFor={`slot-role-${slot.id}`}>Sent as</label>
			<OutgoingRoleSelect id={`slot-role-${slot.id}`} value={fields.role} disabled={disabled} onChange={(role) => onChange({ ...fields, role })} />
			{dirty && <><Button size="xs" disabled={disabled} onClick={() => onSave(fields)}>Save</Button><Button variant="ghost" size="xs" disabled={disabled} onClick={onCancel}>Cancel</Button></>}
		</div>
		{warnings.length > 0 && <ul className="text-xs text-muted-foreground" role="note">{warnings.map((macro) => <li key={macro}>Unknown macro {macro} stays literal.</li>)}</ul>}
	</div>;
};

export function PromptPresetRecipeEditor({
	preset,
	drafts,
	pending,
	problem,
	onDraftChange,
	onDraftCancel,
	onOperation,
}: {
	preset: ConversationPromptPreset;
	drafts: Record<number, BlockDraft>;
	pending: boolean;
	problem: string | null;
	onDraftChange: (blockId: number, draft: BlockDraft) => void;
	onDraftCancel: (blockId: number) => void;
	onOperation: (
		run: () => Promise<PromptPresetOperationOutcome>,
		submitted?: { blockId: number; draft: BlockDraft },
	) => void;
}) {
	return <section aria-label="Selected recipe" className="flex flex-col gap-3">
		<h2 className="text-sm font-medium">{preset.name}: assembled order</h2>
		<ol className="flex flex-col gap-3">
			{preset.slots.map((slot, index) => <li key={slot.id} className={`rounded-lg ring-1 ring-foreground/10 p-3${slot.enabled ? "" : " opacity-60"}`}>
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<h3 className="font-medium">{index + 1}. {slotTitle(slot)}</h3>
					<div className="ml-auto flex items-center gap-1">
						<label className="flex items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={slot.enabled} disabled={pending} onChange={(event) => onOperation(() => setPromptPresetBlockEnabled(preset.id, slot.id, event.target.checked))} />Enabled</label>
						<Button variant="ghost" size="icon-sm" disabled={pending || index === 0} aria-label={`Move ${slotTitle(slot)} up`} onClick={() => onOperation(() => movePromptPresetBlock(preset.id, slot.id, index))}><ChevronUp aria-hidden="true" /></Button>
						<Button variant="ghost" size="icon-sm" disabled={pending || index === preset.slots.length - 1} aria-label={`Move ${slotTitle(slot)} down`} onClick={() => onOperation(() => movePromptPresetBlock(preset.id, slot.id, index + 2))}><ChevronDown aria-hidden="true" /></Button>
						<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Duplicate ${slotTitle(slot)}`} onClick={() => onOperation(() => duplicatePromptPresetBlock(preset.id, slot.id))}><Copy aria-hidden="true" /></Button>
						<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Remove ${slotTitle(slot)}`} onClick={() => onOperation(() => removePromptPresetBlock(preset.id, slot.id))}><Trash2 aria-hidden="true" /></Button>
					</div>
				</div>
				{slot.reference === "instruction" ? <InstructionFieldEditor slot={slot} draft={drafts[slot.id]} disabled={pending} onChange={(fields) => onDraftChange(slot.id, { kind: "content", ...fields })} onCancel={() => onDraftCancel(slot.id)} onSave={(fields) => onOperation(() => setPromptPresetBlockContent(preset.id, slot.id, fields), { blockId: slot.id, draft: { kind: "content", ...fields } })} /> : <><SlotBody slot={slot} />{slot.reference !== "history" && <div className="mt-2 flex flex-wrap items-center gap-2"><label className="text-xs text-muted-foreground" htmlFor={`slot-role-${slot.id}`}>Sent as</label><OutgoingRoleSelect id={`slot-role-${slot.id}`} value={drafts[slot.id]?.kind === "role" ? drafts[slot.id].role : slot.role} disabled={pending} onChange={(role) => onDraftChange(slot.id, { kind: "role", role })} />{drafts[slot.id]?.kind === "role" && draftIsDirty(slot, drafts[slot.id]) && <><Button size="xs" disabled={pending} onClick={() => onOperation(() => setPromptPresetBlockRole(preset.id, slot.id, drafts[slot.id]!.role), { blockId: slot.id, draft: drafts[slot.id]! })}>Save</Button><Button variant="ghost" size="xs" disabled={pending} onClick={() => onDraftCancel(slot.id)}>Cancel</Button></>}</div>}</>}
			</li>)}
			{preset.slots.length === 0 && <li className="rounded-lg ring-1 ring-foreground/10 p-3"><p className="text-muted-foreground">This recipe assembles no context yet. Add a slot below; the Chat still generates, but only from its own submitted writing.</p></li>}
		</ol>
		{problem !== null && <p className="text-destructive text-sm" role="alert">{problem}</p>}
		<div className="flex flex-wrap items-center gap-2">
			<AddSlotSelect disabled={pending} onAdd={(reference) => onOperation(() => addPromptPresetReference(preset.id, reference))} />
			<Button size="xs" disabled={pending} onClick={() => onOperation(() => addPromptPresetInstruction(preset.id))}><Plus aria-hidden="true" /> Instruction</Button>
		</div>
	</section>;
}
