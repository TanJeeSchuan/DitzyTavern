import { hasMoves, type BoxMoves } from "../../shared/contract/box-generation";
import { MoveChips } from "./MoveChips";
import {
	Dices,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Edit3,
	Info,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { Collapsible } from "radix-ui";
import type { Portrait as PortraitImage } from "../../shared/contract/image";
import { type ReactNode, type TouchEvent, useEffect, useRef, useState } from "react";
import {
	type StoryMessage,
	displayedVariantId as getDisplayedVariantId,
	visibleVariantContent,
} from "../story";
import { formatTimestamp } from "../lib/format";
import { GenerationSphere } from "./GenerationSphere";
import { Portrait } from "./Portrait";
import { ProseEditor } from "../editor/ProseEditor";
import { LensedProse, type StoryLens } from "./LensedProse";
import { VariantFan } from "./VariantFan";

// @approved
//  The story renders one native Message from the paginated read model: the
// immutable Author Stamp name, the persisted selected Variant, and the
// existing Swipe navigation. Empty and duplicate Variants stay separate
// positions; an exact empty Variant renders a presentation-only placeholder
// and its stored text is never modified.
export function StoryMessageView({
	message,
	isLatest = false,
	displayedVariantId,
	mutationsDisabled = false,
	generationActive = false,
	previewDownstream = false,
	previewTarget = false,
	portrait,
	onMoveSwipe,
	onSelectVariant,
	onEdit,
	continueLabel = "Continue",
	onContinue,
	onRegenerate,
	onSibling,
	onReroll,
	onMovesChange,
	onInspect,
	boxActions,
	onDelete,
	generationControls,
	lens,
}: {
	message: StoryMessage;
	portrait?: PortraitImage | undefined;
	isLatest?: boolean;
	// The Variant to show when it differs from the persisted selection: a Preview's or a Requested selection's.
	// Persisted activeSwipe remains untouched until the server applies the selection.
	displayedVariantId?: number | null;
	mutationsDisabled?: boolean;
	generationActive?: boolean;
	// @approved
	//  Causally downstream of the previewed Variant: the stored text stays
	// readable but dimmed and non-interactive until the Preview is confirmed
	// or cancelled.
	previewDownstream?: boolean;
	// @approved
	//  This Message is the Preview target: its Swipe controls stay enabled so
	// Variants can be compared freely without server commands, while every
	// other mutation remains locked.
	previewTarget?: boolean;
	onMoveSwipe: (messageId: number, direction: -1 | 1) => void;
	onSelectVariant: (messageId: number, variantId: number) => void;
	onEdit: (messageId: number, content: string) => Promise<boolean>;
	continueLabel?: string;
	onContinue?: (messageId: number) => void;
	onRegenerate?: (messageId: number) => void;
	onSibling?: (messageId: number) => void;
	onReroll?: (messageId: number) => void;
	onMovesChange?: ((messageId: number, moves: BoxMoves) => void) | undefined;
	onInspect?: (messageId: number, variantId: number) => void;
	boxActions?: ReactNode;
	onDelete?: (messageId: number) => void;
	// @approved
	// Inspect and Stop for the Generation writing this Message. They hold the slot Continue
	// takes when it ends, so the story does not jump.
	generationControls?: ReactNode;
	lens?: StoryLens | undefined;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [advancedActionsSelected, setAdvancedActionsSelected] = useState(false);
	const visibleId = displayedVariantId ?? getDisplayedVariantId(message, null);
	const active = message.swipes.find((variant) => variant.id === visibleId);
	const activeIndex = active === undefined
		? message.activeSwipe
		: message.swipes.findIndex((variant) => variant.id === active.id);
	const atLastSwipe = activeIndex === message.swipes.length - 1;
	const previousSwipeDisabled = (mutationsDisabled && !previewTarget) || activeIndex === 0;
	const nextSwipeDisabled = (mutationsDisabled && !previewTarget) || (atLastSwipe && onSibling === undefined);
	const [swipeDirection, setSwipeDirection] = useState<"next" | "previous">();
	const [editText, setEditText] = useState("");
	const authorName = message.authorName ?? "Unknown author";

	useEffect(() => setIsEditing(false), [active?.id]);
	useEffect(() => {
		if (active !== undefined && !isEditing) setEditText(active.content);
	}, [active?.id, active?.content, isEditing]);

	const [editBase, setEditBase] = useState("");
	const [changedElsewhere, setChangedElsewhere] = useState(false);
	const [saving, setSaving] = useState(false);
	const openEditor = () => {
		setEditBase(active?.content ?? "");
		setChangedElsewhere(false);
		setIsEditing(true);
	};
	const saveEdit = async () => {
		const value = editText.trim();
		if ((!value && !hasMoves(message.moves)) || active === undefined) return;
		if (active.content !== editBase) {
			setEditBase(active.content);
			setChangedElsewhere(true);
			return;
		}
		setSaving(true);
		const applied = await onEdit(message.id, value);
		setSaving(false);
		if (applied) setIsEditing(false);
	};
	const movePrevious = () => {
		setSwipeDirection("previous");
		onMoveSwipe(message.id, -1);
	};
	const moveNext = () => {
		setSwipeDirection("next");
		if (atLastSwipe) onSibling?.(message.id);
		else onMoveSwipe(message.id, 1);
	};
	const [fanOpen, setFanOpen] = useState(false);
	const fanDisabled = (mutationsDisabled && !previewTarget) || message.swipes.length < 2;
	const openFan = (open: boolean) => {
		setFanOpen(open);
		// @approved
		//  Closing keeps the Message selected, so its Swipe controls are visible for focus to return to.
		if (!open) setAdvancedActionsSelected(true);
	};
	const selectVariant = (index: number) => {
		openFan(false);
		const variant = message.swipes[index];
		if (variant === undefined || index === activeIndex) return;
		setSwipeDirection(index > activeIndex ? "next" : "previous");
		onSelectVariant(message.id, variant.id);
	};
	// @approved
	//  "fan" marks a touch whose long press opened the fan: its release is not a tap or a swipe.
	const touchStart = useRef<{ x: number; y: number } | "fan" | null>(null);
	// @approved
	//  A still touch held this long opens the fan; any movement past the tap slop leaves it to swipes and scrolling.
	const longPress = useRef<number | undefined>(undefined);
	const cancelLongPress = () => {
		window.clearTimeout(longPress.current);
		longPress.current = undefined;
	};
	const pressOpensFan = () => {
		cancelLongPress();
		touchStart.current = "fan";
		openFan(true);
	};
	const startTouch = (event: TouchEvent<HTMLElement>) => {
		const touch = event.touches[0];
		// @approved
		//  The fan is portalled out of the article, but its touches still bubble here through React.
		const onControl = !(event.target instanceof Element) || !event.currentTarget.contains(event.target) || event.target.closest("button, textarea, input") !== null;
		touchStart.current = event.touches.length === 1 && touch !== undefined && !onControl ? { x: touch.clientX, y: touch.clientY } : null;
		cancelLongPress();
		if (touchStart.current !== null && !fanDisabled && !isEditing) longPress.current = window.setTimeout(pressOpensFan, 450);
	};
	const moveTouch = (event: TouchEvent<HTMLElement>) => {
		const start = touchStart.current;
		const touch = event.touches[0];
		if (start !== null && start !== "fan" && touch !== undefined && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) >= 10) cancelLongPress();
	};
	const endTouch = (event: TouchEvent<HTMLElement>) => {
		cancelLongPress();
		const start = touchStart.current;
		const touch = event.changedTouches[0];
		touchStart.current = null;
		// @approved
		//  Cancelling the release keeps the browser from sending its mouse events and click into the open fan.
		if (start === "fan") event.preventDefault();
		if (start === null || start === "fan" || touch === undefined) return;
		const dx = touch.clientX - start.x;
		const dy = touch.clientY - start.y;
		if (Math.hypot(dx, dy) < 10) {
			event.currentTarget.focus({ preventScroll: true });
			setAdvancedActionsSelected(true);
			return;
		}
		if (isEditing || Math.abs(dx) < 64 || Math.abs(dx) <= 2 * Math.abs(dy)) return;
		if (event.target instanceof Element && event.target.closest("pre") !== null) return;
		if (dx < 0 && !nextSwipeDisabled) moveNext();
		if (dx > 0 && !previousSwipeDisabled) movePrevious();
	};

	return (
		<article
			className="story-message"
			data-latest={isLatest}
			tabIndex={0}
			data-message-id={message.id}
			data-author-in-cast={message.inCast}
			data-previewing={previewTarget}
			data-preview-downstream={previewDownstream}
			inert={previewDownstream || undefined}
			data-selected={advancedActionsSelected}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
				if (event.key === "ArrowLeft" && !previousSwipeDisabled) {
					event.preventDefault();
					movePrevious();
				}
				if (event.key === "ArrowRight" && !nextSwipeDisabled) {
					event.preventDefault();
					moveNext();
				}
			}}
			onTouchStart={startTouch}
			onTouchMove={moveTouch}
			onTouchEnd={endTouch}
			onTouchCancel={() => {
				cancelLongPress();
				touchStart.current = null;
			}}
			// @approved
			//  Android announces its own long press as a context menu first; that press opens the fan instead of selecting text.
			onContextMenu={(event) => {
				if (longPress.current === undefined) return;
				event.preventDefault();
				pressOpensFan();
			}}
			onBlur={(event) => {
				if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
					setAdvancedActionsSelected(false);
				}
			}}
		>
			<header className="message-header">
				<Portrait name={authorName} portrait={portrait} size="medium" />
				<div className="message-author">
					<strong>{authorName}</strong>
					{generationActive && <GenerationSphere authorName={authorName} />}
					<div className="message-meta">
						<time>{formatTimestamp(message.timestamp)}</time>
						{!message.inCast && <span className="not-in-cast">not in Cast</span>}
						{previewTarget && <span className="message-preview-marker">Previewed Swipe</span>}
					</div>
				</div>
				<div className="advanced-actions" aria-label="Advanced Message actions">
					{onSibling !== undefined && (
						<button
							className="edit-action"
							type="button"
							disabled={mutationsDisabled}
							onClick={() => onSibling(message.id)}
						>
							<RefreshCw aria-hidden="true" /> New Swipe
						</button>
					)}
					{onReroll !== undefined && <button className="edit-action" type="button" disabled={mutationsDisabled} onClick={() => onReroll(message.id)}>
						<Dices aria-hidden="true" /> Re-roll
					</button>}
					{onInspect !== undefined && active !== undefined && (
						<button
							className="edit-action"
							type="button"
							onClick={() => onInspect(message.id, active.id)}
						>
							<Info aria-hidden="true" /> Details
						</button>
					)}
					{boxActions}
					{onDelete !== undefined && (
						<button
							className="edit-action delete-action"
							type="button"
							disabled={mutationsDisabled}
							onClick={() => {
								if (window.confirm("Delete this Message?")) onDelete(message.id);
							}}
						>
							<Trash2 aria-hidden="true" /> Delete
						</button>
					)}
				</div>
			</header>
			<MoveChips moves={message.moves} disabled={mutationsDisabled}
				onChange={onMovesChange === undefined ? undefined : (moves) => onMovesChange(message.id, moves)} />
			{isEditing && active !== undefined ? (
				<div className="message-editor">
					<span>Edit Message</span>
					<ProseEditor value={editText} onChange={setEditText} ariaLabel="Edit Message" autoFocus disabled={saving} />
					{changedElsewhere && <small className="field-error" role="alert">Changed elsewhere. Save again to overwrite.</small>}
					<div>
						<button
							className="secondary-button"
							type="button"
							disabled={mutationsDisabled || saving}
							onClick={() => setIsEditing(false)}
						>
							Cancel
						</button>
						<button
							className="primary-button"
							type="button"
							disabled={mutationsDisabled || saving}
							onClick={saveEdit}
						>
							Save
						</button>
					</div>
				</div>
			) : (
				<div
					key={active?.id}
					className="variant-content"
					data-swipe-direction={swipeDirection}
				>
					{active?.reasoning !== undefined && active.reasoning !== "" && (
						<Collapsible.Root className="reasoning-content" aria-label="Reasoning Content">
							<Collapsible.Trigger className="reasoning-trigger">
								<strong>Reasoning</strong>
								<ChevronDown aria-hidden="true" />
							</Collapsible.Trigger>
							<Collapsible.Content className="reasoning-body">
								{active.reasoning
									.split("\n\n")
									.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
							</Collapsible.Content>
						</Collapsible.Root>
					)}
					{!(active?.empty === true && hasMoves(message.moves)) && <div
						className="prose"
						data-empty-variant={active?.empty === true && !generationActive}
						data-generation-active={generationActive}
					>
						{active !== undefined && !(generationActive && active.empty)
							? <LensedProse text={visibleVariantContent(active)} streaming={generationActive} lens={lens} />
							: null}
					</div>}
				</div>
			)}

			<footer className="message-actions">
				<div className="message-primary-actions">
					<button
						className="edit-action"
						type="button"
						disabled={mutationsDisabled || generationActive}
						onClick={openEditor}
					>
						<Edit3 aria-hidden="true" /> Edit
					</button>
					{generationControls}
					{onRegenerate !== undefined && (
						<button
							className="secondary-button continue-action"
							type="button"
							disabled={mutationsDisabled}
							onClick={() => onRegenerate(message.id)}
						>
							<RefreshCw aria-hidden="true" /> Regenerate response
						</button>
					)}
					{onContinue !== undefined && (
						<button
							className="secondary-button continue-action"
							type="button"
							disabled={mutationsDisabled}
							onClick={() => onContinue(message.id)}
						>
							{continueLabel}
						</button>
					)}
				</div>
				<div className="swipe-controls" aria-label="Swipe controls">
					<button
						className="icon-button"
						type="button"
						onClick={movePrevious}
						disabled={previousSwipeDisabled}
						aria-label="Previous Swipe"
					>
						<ChevronLeft aria-hidden="true" />
					</button>
					<VariantFan variants={message.swipes} shownIndex={activeIndex} open={fanOpen} onOpenChange={openFan} onSelect={selectVariant}>
						<button className="swipe-count" type="button" disabled={fanDisabled} aria-label={`${activeIndex + 1} of ${message.swipes.length}, browse Swipes`}>
							{activeIndex + 1} of {message.swipes.length}
						</button>
					</VariantFan>
					<button
						className="icon-button"
						type="button"
						onClick={moveNext}
						disabled={nextSwipeDisabled}
						aria-label={atLastSwipe ? "New Swipe" : "Next Swipe"}
					>
						<ChevronRight aria-hidden="true" />
					</button>
				</div>
			</footer>
		</article>
	);
}
