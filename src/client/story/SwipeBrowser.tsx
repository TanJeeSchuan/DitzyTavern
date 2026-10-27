import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type CSSProperties, type RefObject, useEffect, useId, useRef, useState } from "react";
import type { SwipeBrowsing } from "../workspace";
import { type StoryVariant, visibleVariantContent } from "../story";
import { Prose } from "./prose";

// @approved
//  Pixels of drag that move the fan by one card, and how many milliseconds of a flick's speed carry on after release.
const CARD_STEP = 88;
const FLICK_MS = 140;

type Browse = { variants: StoryVariant[]; shownIndex: number; onSelect: (index: number) => void };

/**
 * @approved A Message's Swipes in a dialog, as a held fan of cards or as a plain list. The Message mounts it only
 * while it is open; closing it by Escape or an outside tap changes nothing and returns focus to the counter.
 */
export function SwipeBrowser({ mode, returnFocus, onClose, ...browse }: Browse & {
	mode: SwipeBrowsing;
	returnFocus: RefObject<HTMLElement | null>;
	onClose: () => void;
}) {
	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog.Portal>
				<Dialog.Overlay className="swipe-browser-overlay" />
				<Dialog.Content
					className={mode === "fan" ? "variant-fan" : "swipe-list"}
					aria-describedby={undefined}
					onContextMenu={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						returnFocus.current?.focus();
					}}
				>
					{mode === "fan" ? <>
						<Dialog.Title className="sr-only">Swipes</Dialog.Title>
						<Deck {...browse} onDismiss={onClose} />
					</> : <>
						<header>
							<Dialog.Title>Swipes</Dialog.Title>
							<Dialog.Close className="icon-button" aria-label="Close"><X aria-hidden="true" /></Dialog.Close>
						</header>
						<List {...browse} />
					</>}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

// @approved
//  One Swipe as a card: its position, whether it is the shown Swipe, and its prose. Enter or Space picks it.
function Card({ variant, index, count, current, onSelect, ref, ...props }: {
	variant: StoryVariant;
	index: number;
	count: number;
	current: boolean;
	onSelect: () => void;
	ref: (node: HTMLElement | null) => void;
	className: string;
	tabIndex: number;
	style?: CSSProperties;
	onClick: () => void;
	"data-front"?: boolean;
}) {
	const id = useId();
	const prose = useRef<HTMLDivElement>(null);
	// @approved
	//  The excerpt is inert, but Radix still counts its links and image buttons when it wraps Tab inside the dialog.
	useEffect(() => prose.current?.querySelectorAll<HTMLElement>("a[href], button").forEach((element) => { element.tabIndex = -1; }), [variant.content]);
	return (
		<div
			{...props}
			ref={ref}
			role="button"
			aria-label={`Swipe ${index + 1} of ${count}`}
			aria-describedby={id}
			aria-current={current || undefined}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onSelect();
			}}
		>
			<header>
				<span>{index + 1} of {count}</span>
				{current && <span className="swipe-card-current">Current</span>}
			</header>
			<div ref={prose} id={id} className="swipe-card-prose prose" data-empty-variant={variant.empty} inert>
				<Prose text={visibleVariantContent(variant)} streaming={false} />
			</div>
		</div>
	);
}

function List({ variants, shownIndex, onSelect }: Browse) {
	const cards = useRef<(HTMLElement | null)[]>([]);
	// @approved
	//  Focus the shown card on opening, and again if the focused card's Variant goes away while the list is open.
	useEffect(() => {
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && focused.closest(".swipe-list") !== null && !focused.classList.contains("swipe-list")) return;
		(cards.current[shownIndex] ?? cards.current[0])?.focus();
	}, [variants.map((variant) => variant.id).join()]);
	return (
		<ol
			onKeyDown={(event) => {
				const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
				const at = cards.current.findIndex((card) => card === document.activeElement);
				if (step === 0 || at === -1) return;
				event.preventDefault();
				cards.current[Math.min(variants.length - 1, Math.max(0, at + step))]?.focus();
			}}
		>
			{variants.map((variant, index) => (
				<li key={variant.id}>
					<Card
						variant={variant}
						index={index}
						count={variants.length}
						current={index === shownIndex}
						ref={(node) => { cards.current[index] = node; }}
						className="swipe-card"
						tabIndex={0}
						onClick={() => onSelect(index)}
						onSelect={() => onSelect(index)}
					/>
				</li>
			))}
		</ol>
	);
}

function Deck({ variants, shownIndex, onSelect, onDismiss }: Browse & { onDismiss: () => void }) {
	const last = variants.length - 1;
	const clamp = (position: number) => Math.min(last, Math.max(0, position));
	const [position, setPosition] = useState(shownIndex);
	const [drag, setDrag] = useState<{ pointer: number; x: number; from: number } | null>(null);
	// @approved
	//  Recent pointer samples for the release speed.
	const samples = useRef<{ x: number; t: number }[]>([]);
	// @approved
	//  The click that ends a drag is dropped. A tap, a keyboard or screen-reader activation clicks.
	const press = useRef<"tap" | "drag" | null>(null);
	const cards = useRef<(HTMLElement | null)[]>([]);
	const front = clamp(Math.round(position));
	useEffect(() => cards.current[front]?.focus({ preventScroll: true }), [front, variants[front]?.id]);

	return (
		<div
			className="variant-fan-surface"
			data-dragging={drag !== null}
			onPointerDown={(event) => {
				if (event.button !== 0 || drag !== null) return;
				press.current = "tap";
				samples.current = [{ x: event.clientX, t: event.timeStamp }];
				setDrag({ pointer: event.pointerId, x: event.clientX, from: position });
			}}
			onPointerMove={(event) => {
				if (drag?.pointer !== event.pointerId) return;
				const dx = event.clientX - drag.x;
				// @approved
				//  Capture only once it is a drag, so a tap keeps its card as the click target.
				if (press.current === "tap" && Math.abs(dx) > 6) {
					press.current = "drag";
					event.currentTarget.setPointerCapture(event.pointerId);
				}
				if (press.current !== "drag") return;
				samples.current = [...samples.current.filter((sample) => event.timeStamp - sample.t < 100), { x: event.clientX, t: event.timeStamp }];
				const next = drag.from - dx / CARD_STEP;
				setPosition(next < 0 ? next / 3 : next > last ? last + (next - last) / 3 : next);
			}}
			onPointerUp={(event) => {
				if (drag?.pointer !== event.pointerId) return;
				setDrag(null);
				if (press.current !== "drag") return;
				const first = samples.current.find((sample) => event.timeStamp - sample.t < 100);
				const speed = first === undefined ? 0 : (event.clientX - first.x) / Math.max(1, event.timeStamp - first.t);
				setPosition(clamp(Math.round(position - speed * FLICK_MS / CARD_STEP)));
			}}
			onPointerCancel={(event) => {
				if (drag?.pointer !== event.pointerId) return;
				press.current = null;
				setDrag(null);
				setPosition(front);
			}}
			onClickCapture={(event) => {
				if (press.current === "drag") event.stopPropagation();
				press.current = null;
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) onDismiss();
			}}
			onKeyDown={(event) => {
				const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
				if (step === 0) return;
				event.preventDefault();
				setPosition(clamp(front + step));
			}}
		>
			<div className="variant-fan-deck">
				{variants.map((variant, index) => {
					const offset = index - position;
					return (
						<Card
							key={variant.id}
							variant={variant}
							index={index}
							count={variants.length}
							current={index === shownIndex}
							ref={(node) => { cards.current[index] = node; }}
							className="swipe-card variant-card"
							tabIndex={index === front ? 0 : -1}
							data-front={index === front}
							// @approved
							// SAFETY: React passes custom properties through to the style; CSSProperties only lacks their names.
							style={{
								"--offset": offset,
								"--distance": Math.abs(offset),
								"--deal": Math.min(Math.abs(index - shownIndex), 4),
								zIndex: variants.length - Math.round(Math.abs(offset)),
								// @approved
								//  The CSS fades a card out by this distance; past it, it must not catch taps meant to dismiss.
								pointerEvents: Math.abs(offset) >= 3.2 ? "none" : undefined,
							} as CSSProperties}
							onClick={() => (index === front ? onSelect(index) : setPosition(index))}
							onSelect={() => onSelect(index)}
						/>
					);
				})}
			</div>
		</div>
	);
}
