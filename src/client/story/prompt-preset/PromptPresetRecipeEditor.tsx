import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	addPromptPresetInstruction,
	addPromptPresetReference,
} from "../../prompt-preset-library";
import type { ConversationPromptPreset, PromptBlockReference } from "../../../shared/contract/prompt-preset";
import { isPromptBlockReference, slotLabels } from "../../prompt-preset-presentation";
import type { BlockDraft } from "../../prompt-preset-editor-state";
import { PromptPresetSelect } from "./PromptPresetSelect";
import { PromptPresetRecipeRow, type RecipeOperationHandlers } from "./PromptPresetRecipeRow";

const AddSlotSelect = ({
	disabled,
	onAdd,
}: {
	disabled: boolean;
	onAdd: (reference: PromptBlockReference) => void;
}) => {
	const [selection, setSelection] = useState<PromptBlockReference | "">("");
	return (
		<>
			<PromptPresetSelect
				id="prompt-preset-add"
				label="Add a slot to the recipe"
				value={selection}
				emptyLabel="Choose a reference…"
				labels={slotLabels}
				isOption={isPromptBlockReference}
				disabled={disabled}
				onChange={setSelection}
			/>
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
