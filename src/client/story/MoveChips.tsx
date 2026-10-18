import { DragDropProvider } from "@dnd-kit/react";
import { isSortableOperation, useSortable } from "@dnd-kit/react/sortable";
import { X, type LucideIcon } from "lucide-react";
import { boxDescriptor, type BoxId } from "../../shared/contract/box";
import { boxEntryOf, type BoxValue } from "../../shared/contract/box-value";
import { hasMoves, moveLabel, replaceMoves, type BoxMoves } from "../../shared/contract/box-generation";
import { BoxBoundary, BoxIcon } from "../box-windows/BoxBoundary";
import { boxClients } from "../box-windows/registry";

function MoveChip({ id, index, box, icon, label, disabled, onRemove }: {
	id: string; index: number; box: BoxId; icon: LucideIcon; label: string; disabled: boolean; onRemove?: (() => void) | undefined;
}) {
	const { ref, handleRef, isDragging } = useSortable({ id, index, disabled: disabled || onRemove === undefined });
	return <li ref={ref} className="move-chip" data-dragging={isDragging || undefined}>
		<span ref={handleRef}><BoxIcon box={box} icon={icon} />{label}</span>
		{onRemove !== undefined && <button type="button" disabled={disabled} aria-label={`Remove ${label}`} onClick={onRemove}><X aria-hidden="true" /></button>}
	</li>;
}

/** @approved One Box's Moves in resolution order. Order only matters within a Box, so each Box sorts on its own. */
function MoveList<Move>({ name, box, icon, list, label, onChange, disabled }: {
	name: string; box: BoxId; icon: LucideIcon; list: readonly Move[]; label: (move: Move) => string; onChange?: ((moves: Move[]) => void) | undefined; disabled: boolean;
}) {
	if (list.length === 0) return null;
	const labels = list.map(label);
	// @approved
	//  Equal Moves are interchangeable, so a Move's id is its label and its
	//  occurrence.
	const chips = labels.map((text, index) => ({ label: text, id: `${text}:${labels.slice(0, index).filter((earlier) => earlier === text).length}` }));
	return <DragDropProvider onDragEnd={(event) => {
		if (event.canceled || !isSortableOperation(event.operation)) return;
		const { source } = event.operation;
		if (source === null || source.initialIndex === source.index) return;
		const next = [...list];
		next.splice(source.index, 0, ...next.splice(source.initialIndex, 1));
		onChange?.(next);
	}}>
		<ol aria-label={name}>
			{chips.map(({ id, label: text }, index) => <MoveChip key={id} id={id} index={index} box={box} icon={icon} label={text} disabled={disabled}
				onRemove={onChange === undefined ? undefined : () => onChange(list.filter((__, position) => position !== index))} />)}
		</ol>
	</DragDropProvider>;
}

/** @approved A Message's Moves per Box. With `onChange` they can be dragged into another order or removed. */
export function MoveChips({ moves, onChange, disabled = false }: { moves: BoxMoves; onChange?: ((moves: BoxMoves) => void) | undefined; disabled?: boolean }) {
	if (!hasMoves(moves)) return null;
	return <div className="move-chips">
		{[...boxClients()].map(([id, { icon }]) => boxDescriptor(id).moves === undefined ? null : <BoxBoundary key={id} box={id}>
			<MoveList<BoxValue> name={`${boxDescriptor(id).label} Moves`} box={id} icon={icon} list={boxEntryOf(moves, id) ?? []} label={(move) => moveLabel(id, move)} disabled={disabled}
				onChange={onChange && ((next) => onChange(replaceMoves(moves, id, next)))} />
		</BoxBoundary>)}
	</div>;
}
