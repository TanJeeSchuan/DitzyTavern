import { DragDropProvider } from "@dnd-kit/react";
import { isSortableOperation, useSortable } from "@dnd-kit/react/sortable";
import { X } from "lucide-react";
import type { BoxMoves } from "../../shared/contract/box-generation";
import type { RaceMove } from "../../shared/contract/race";
import { raceMoveLabel } from "../../shared/race-moves";

function MoveChip({ id, index, move, disabled, onRemove }: { id: string; index: number; move: RaceMove; disabled: boolean; onRemove?: (() => void) | undefined }) {
	const { ref, handleRef, isDragging } = useSortable({ id, index, disabled: disabled || onRemove === undefined });
	const label = raceMoveLabel(move);
	return <li ref={ref} className="move-chip" data-dragging={isDragging || undefined}>
		<span ref={handleRef}>{label}</span>
		{onRemove !== undefined && <button type="button" disabled={disabled} aria-label={`Remove ${label}`} onClick={onRemove}><X aria-hidden="true" /></button>}
	</li>;
}

/** @approved A Message's Moves in resolution order. With `onChange` they can be dragged into another order or removed. */
export function MoveChips({ moves, onChange, disabled = false }: { moves: BoxMoves; onChange?: ((moves: BoxMoves) => void) | undefined; disabled?: boolean }) {
	const list = moves.race ?? [];
	if (list.length === 0) return null;
	const set = (next: RaceMove[]) => onChange?.(next.length === 0 ? {} : { race: next });
	// @approved Equal Moves are interchangeable, so a Move's id is its value and its occurrence.
	const ids = list.map((move, index) => `${move.kind}:${move.runner}:${list.slice(0, index).filter((earlier) => earlier.kind === move.kind && earlier.runner === move.runner).length}`);
	return <DragDropProvider onDragEnd={(event) => {
		if (event.canceled || !isSortableOperation(event.operation)) return;
		const { source } = event.operation;
		if (source === null || source.initialIndex === source.index) return;
		const next = [...list];
		next.splice(source.index, 0, ...next.splice(source.initialIndex, 1));
		set(next);
	}}>
		<ol className="move-chips" aria-label="Moves">
			{list.map((move, index) => <MoveChip key={ids[index]} id={ids[index]!} index={index} move={move} disabled={disabled}
				onRemove={onChange === undefined ? undefined : () => set(list.filter((_, position) => position !== index))} />)}
		</ol>
	</DragDropProvider>;
}
