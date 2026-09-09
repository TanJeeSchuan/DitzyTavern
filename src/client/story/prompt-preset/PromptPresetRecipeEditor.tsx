import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	addPromptPresetInstruction,
	addPromptPresetReference,
	type ConversationPromptPreset,
	type PromptBlockReference,
} from "../../conversation";
import { slotLabels } from "../../prompt-preset-presentation";
import type { BlockDraft } from "../../prompt-preset-editor-state";
import { PromptPresetRecipeRow, roleSelectClass, type RecipeOperationHandlers } from "./PromptPresetRecipeRow";

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
} & RecipeOperationHandlers) {
	return <section aria-label="Selected recipe" className="flex flex-col gap-3">
		<h2 className="text-sm font-medium">{preset.name}: assembled order</h2>
		<ol className="flex flex-col gap-3">
			{preset.slots.map((slot, index) => (
				<PromptPresetRecipeRow
					key={slot.id}
					presetId={preset.id}
					slot={slot}
					index={index}
					slotCount={preset.slots.length}
					draft={drafts[slot.id]}
					pending={pending}
					onDraftChange={onDraftChange}
					onDraftCancel={onDraftCancel}
					onOperation={onOperation}
				/>
			))}
			{preset.slots.length === 0 && <li className="rounded-lg ring-1 ring-foreground/10 p-3"><p className="text-muted-foreground">This recipe assembles no context yet. Add a slot below; the Chat still generates, but only from its own submitted writing.</p></li>}
		</ol>
		{problem !== null && <p className="text-destructive text-sm" role="alert">{problem}</p>}
		<div className="flex flex-wrap items-center gap-2">
			<AddSlotSelect disabled={pending} onAdd={(reference) => onOperation(() => addPromptPresetReference(preset.id, reference))} />
			<Button size="xs" disabled={pending} onClick={() => onOperation(() => addPromptPresetInstruction(preset.id))}><Plus aria-hidden="true" /> Instruction</Button>
		</div>
	</section>;
}
