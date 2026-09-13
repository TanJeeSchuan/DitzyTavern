import { useEffect, useState } from "react";
import { AutoScroller } from "@dnd-kit/dom";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortableOperation } from "@dnd-kit/react/sortable";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	addPromptPresetInstruction,
	addPromptPresetReference,
	movePromptPresetBlock,
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
	const [orderedSlots, setOrderedSlots] = useState(preset.slots);
	useEffect(() => {
		if (!pending) setOrderedSlots(preset.slots);
	}, [pending, preset.slots]);

	return <section aria-label="Selected recipe" className="flex flex-col gap-3">
		<DragDropProvider
			plugins={(defaults) => [...defaults, AutoScroller.configure({
				acceleration: 8,
				threshold: { x: 0, y: 0.05 },
			})]}
			onDragEnd={(event) => {
				if (event.canceled || pending || !isSortableOperation(event.operation)) return;
				const { source } = event.operation;
				if (source === null) return;
				// ==[HUMAN APPROVED]== SAFETY: Every sortable in this provider receives its numeric prompt block ID.
				const sourceId = source.id as number;
				if (source.initialIndex === source.index) return;
				setOrderedSlots((current) => {
					const sourceIndex = current.findIndex((slot) => slot.id === sourceId);
					if (sourceIndex === -1) return current;
					const next = [...current];
					const [moved] = next.splice(sourceIndex, 1);
					if (moved === undefined) return current;
					next.splice(source.index, 0, moved);
					return next;
				});
				onOperation(() => movePromptPresetBlock(preset.id, sourceId, source.index + 1));
			}}
		>
		<ol className="divide-y divide-border border-y border-border">
			{orderedSlots.map((slot, index) => (
				<PromptPresetRecipeRow
					key={slot.id}
					presetId={preset.id}
					slot={slot}
					index={index}
					slotCount={orderedSlots.length}
					draft={drafts[slot.id]}
					pending={pending}
					onDraftChange={onDraftChange}
					onDraftCancel={onDraftCancel}
					onOperation={onOperation}
				/>
			))}
			{orderedSlots.length === 0 && <li className="py-3"><p className="text-muted-foreground">This recipe assembles no context yet. Add a slot below; the Chat still generates, but only from its own submitted writing.</p></li>}
		</ol>
		</DragDropProvider>
		{problem !== null && <p className="text-destructive text-sm" role="alert">{problem}</p>}
		<div className="flex flex-wrap items-center gap-2">
			<AddSlotSelect disabled={pending} onAdd={(reference) => onOperation(() => addPromptPresetReference(preset.id, reference))} />
			<Button size="xs" disabled={pending} onClick={() => onOperation(() => addPromptPresetInstruction(preset.id))}><Plus aria-hidden="true" /> Instruction</Button>
		</div>
	</section>;
}
