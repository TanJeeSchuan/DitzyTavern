import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

const nameInputClass = "rounded-lg border border-border bg-background px-2 py-1 font-medium text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const textInputClass = "min-h-20 w-full rounded-lg border border-border bg-background px-2 py-1 text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

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

// ==[HUMAN APPROVED]== One recipe row: the ordered slot header, its read-only or authored body,
// and the immediate ordering and toggle controls. The draft it shows belongs
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
	const title = slotTitle(slot);
	const roleDraft = draft?.kind === "role" ? draft : null;
	return <li className={`rounded-lg ring-1 ring-foreground/10 p-3${slot.enabled ? "" : " opacity-60"}`}>
		<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
			<h3 className="font-medium">{index + 1}. {title}</h3>
			<div className="ml-auto flex items-center gap-1">
				<label className="flex items-center gap-1 text-xs text-muted-foreground">
					<input type="checkbox" checked={slot.enabled} disabled={pending} onChange={(event) => onOperation(() => setPromptPresetBlockEnabled(presetId, slot.id, event.target.checked))} />
					Enabled
				</label>
				<Button variant="ghost" size="icon-sm" disabled={pending || index === 0} aria-label={`Move ${title} up`} onClick={() => onOperation(() => movePromptPresetBlock(presetId, slot.id, index))}><ChevronUp aria-hidden="true" /></Button>
				<Button variant="ghost" size="icon-sm" disabled={pending || index === slotCount - 1} aria-label={`Move ${title} down`} onClick={() => onOperation(() => movePromptPresetBlock(presetId, slot.id, index + 2))}><ChevronDown aria-hidden="true" /></Button>
				<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Duplicate ${title}`} onClick={() => onOperation(() => duplicatePromptPresetBlock(presetId, slot.id))}><Copy aria-hidden="true" /></Button>
				<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Remove ${title}`} onClick={() => onOperation(() => removePromptPresetBlock(presetId, slot.id))}><Trash2 aria-hidden="true" /></Button>
			</div>
		</div>
		{slot.reference === "instruction" ? (
			<InstructionFieldEditor
				slot={slot}
				draft={draft}
				disabled={pending}
				onChange={(fields) => onDraftChange(slot.id, { kind: "content", ...fields })}
				onCancel={() => onDraftCancel(slot.id)}
				onSave={(fields) => saveDraftPatch(presetId, slot, { kind: "content", ...fields }, onOperation)}
			/>
		) : (
			<>
				<SlotBody slot={slot} />
				{slot.reference !== "history" && (
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<label className="text-xs text-muted-foreground" htmlFor={`slot-role-${slot.id}`}>Sent as</label>
						<OutgoingRoleSelect
							id={`slot-role-${slot.id}`}
							value={roleDraft?.role ?? slot.role}
							disabled={pending}
							onChange={(role) => onDraftChange(slot.id, { kind: "role", role })}
						/>
						{roleDraft !== null && draftIsDirty(slot, roleDraft) && (
							<>
								<Button
									size="xs"
									disabled={pending}
									onClick={() => saveDraftPatch(presetId, slot, roleDraft, onOperation)}
								>
									Save
								</Button>
								<Button variant="ghost" size="xs" disabled={pending} onClick={() => onDraftCancel(slot.id)}>Cancel</Button>
							</>
						)}
					</div>
				)}
			</>
		)}
	</li>;
}
