import { useEffect, useRef, useState } from "react";
import { AutoScroller } from "@dnd-kit/dom";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortableOperation } from "@dnd-kit/react/sortable";
import { ChevronDown, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "@/components/ui/button";
import {
	addPromptPresetInstruction,
	addPromptPresetReference,
	movePromptPresetBlock,
} from "../../prompt-preset-library";
import type { ConversationPromptPreset, PromptBlockReference } from "../../../shared/contract/prompt-preset";
import { slotLabels } from "../../prompt-preset-presentation";
import type { BlockDraft } from "../../prompt-preset-editor-state";
import { PromptPresetRecipeRow, type RecipeOperationHandlers } from "./PromptPresetRecipeRow";

const addableReferences = [
	"model-system-instruction",
	"human-identity",
	"model-identity",
	"model-scenario",
	"model-example-dialogue",
	"history",
	"model-post-history-instruction",
	"lore",
] as const satisfies readonly PromptBlockReference[];

const AddBlockMenu = ({
	disabled,
	onAddReference,
	onAddInstruction,
}: {
	disabled: boolean;
	onAddReference: (reference: PromptBlockReference) => void;
	onAddInstruction: () => void;
}) => {
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<Button type="button" size="xs" variant="ghost" className="border-0 px-0 text-muted-foreground" disabled={disabled}>
					<span className="flex items-center gap-1"><Plus aria-hidden="true" /> Add block</span>
					<ChevronDown aria-hidden="true" />
				</Button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={6}
					className="z-50 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none"
				>
					<DropdownMenu.Label className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Reference</DropdownMenu.Label>
					{addableReferences.map((reference) => (
						<DropdownMenu.Item
							key={reference}
							className="cursor-default rounded-md px-2 py-1.5 outline-none select-none focus:bg-muted"
							onSelect={() => onAddReference(reference)}
						>
							{slotLabels[reference]}
						</DropdownMenu.Item>
					))}
					<DropdownMenu.Separator className="my-1 h-px bg-border" />
					<DropdownMenu.Item
						className="cursor-default rounded-md px-2 py-1.5 outline-none select-none focus:bg-muted"
						onSelect={onAddInstruction}
					>
						New custom instruction
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
};

export function PromptPresetRecipeEditor({
	preset,
	drafts,
	pending,
	problem,
	onDraftChange,
	onEnabledChange,
	onDraftCancel,
	onOperation,
}: {
	preset: ConversationPromptPreset;
	drafts: Record<number, BlockDraft>;
	pending: boolean;
	problem: string | null;
} & RecipeOperationHandlers) {
	const [orderedSlots, setOrderedSlots] = useState(preset.slots);
	const [newInstructionEditorId, setNewInstructionEditorId] = useState<number | null>(null);
	const slotListRef = useRef<HTMLOListElement>(null);
	const previousRenderedRecipe = useRef({ presetId: preset.id, slotCount: preset.slots.length });
	const instructionIdsBeforeAdd = useRef<Set<number> | null>(null);
	useEffect(() => {
		if (!pending) setOrderedSlots(preset.slots);
	}, [pending, preset.slots]);
	useEffect(() => {
		const previousIds = instructionIdsBeforeAdd.current;
		if (previousIds === null) return;
		const added = preset.slots.find((slot) => slot.reference === "instruction" && !previousIds.has(slot.id));
		if (added !== undefined) {
			instructionIdsBeforeAdd.current = null;
			setNewInstructionEditorId(added.id);
		} else if (!pending && problem !== null) {
			instructionIdsBeforeAdd.current = null;
		}
	}, [pending, preset.slots, problem]);
	useEffect(() => {
		const previous = previousRenderedRecipe.current;
		if (previous.presetId !== preset.id) {
			previousRenderedRecipe.current = { presetId: preset.id, slotCount: preset.slots.length };
			return;
		}
		if (!pending && orderedSlots.length > previous.slotCount) {
			slotListRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
		}
		previousRenderedRecipe.current = { presetId: preset.id, slotCount: orderedSlots.length };
	}, [orderedSlots.length, pending, preset.id, preset.slots.length]);

	return <section aria-label="Preset contents" className="flex flex-col gap-3 border-t border-border pt-5">
		<div className="flex items-center justify-between gap-2">
			<h2 className="whitespace-nowrap text-sm font-medium">Preset contents</h2>
			<AddBlockMenu
				disabled={pending}
				onAddReference={(reference) => onOperation(() => addPromptPresetReference(preset.id, reference))}
				onAddInstruction={() => {
					instructionIdsBeforeAdd.current = new Set(
						preset.slots.filter((slot) => slot.reference === "instruction").map((slot) => slot.id),
					);
					onOperation(() => addPromptPresetInstruction(preset.id));
				}}
			/>
		</div>
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
		<ol ref={slotListRef} className="divide-y divide-border border-b border-border">
			{orderedSlots.map((slot, index) => (
				<PromptPresetRecipeRow
					key={slot.id}
					presetId={preset.id}
					slot={slot}
					index={index}
					slotCount={orderedSlots.length}
					draft={drafts[slot.id]}
					pending={pending}
					autoOpenEditor={newInstructionEditorId === slot.id}
					onAutoOpenEditorHandled={() => setNewInstructionEditorId(null)}
					onDraftChange={onDraftChange}
					onEnabledChange={onEnabledChange}
					onDraftCancel={onDraftCancel}
					onOperation={onOperation}
				/>
			))}
			{orderedSlots.length === 0 && <li className="py-3"><p className="text-muted-foreground">This recipe assembles no context yet. Add a slot below; the Chat still generates, but only from its own submitted writing.</p></li>}
		</ol>
		</DragDropProvider>
		{problem !== null && <p className="text-destructive text-sm" role="alert">{problem}</p>}
	</section>;
}
