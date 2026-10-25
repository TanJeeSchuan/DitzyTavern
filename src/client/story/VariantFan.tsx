import { Dialog } from "radix-ui";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type StoryVariant, visibleVariantContent } from "../story";
import { Prose } from "./prose";

// @approved Pixels of drag that move the fan by one card, and how many milliseconds of a flick's speed carry on after release.
const CARD_STEP = 88;
const FLICK_MS = 140;

/** @approved A Message's Swipes laid out as a held fan of cards: browse by drag, flick or arrow keys, pick one with a tap or Enter. */
export function VariantFan({ variants, shownIndex, open, onOpenChange, onSelect, children }: {
	variants: StoryVariant[];
	shownIndex: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (index: number) => void;
	children: ReactNode;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Trigger asChild>{children}</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Overlay className="variant-fan-overlay" />
				<Dialog.Content className="variant-fan" aria-describedby={undefined} onContextMenu={(event) => event.preventDefault()}>
					<Dialog.Title className="sr-only">Swipes</Dialog.Title>
					<Deck variants={variants} shownIndex={shownIndex} onSelect={onSelect} onDismiss={() => onOpenChange(false)} />
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function Deck({ variants, shownIndex, onSelect, onDismiss }: {
	variants: StoryVariant[];
	shownIndex: number;
	onSelect: (index: number) => void;
	onDismiss: () => void;
}) {
	const id = useId();
	const last = variants.length - 1;
	const clamp = (position: number) => Math.min(last, Math.max(0, position));
	const [position, setPosition] = useState(shownIndex);
	const [drag, setDrag] = useState<{ x: number; from: number } | null>(null);
	// @approved Recent pointer samples for the release speed.
	const samples = useRef<{ x: number; t: number }[]>([]);
	// @approved Only a tap that went down inside the fan clicks: not the end of a drag,
	// nor the release of the long press that opened the fan.
	const press = useRef<"tap" | "drag" | null>(null);
	const cards = useRef<(HTMLElement | null)[]>([]);
	const front = clamp(Math.round(position));
	useEffect(() => cards.current[front]?.focus({ preventScroll: true }), [front]);

	return (
		<div
			className="variant-fan-surface"
			data-dragging={drag !== null}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				press.current = "tap";
				samples.current = [{ x: event.clientX, t: event.timeStamp }];
				setDrag({ x: event.clientX, from: position });
			}}
			onPointerMove={(event) => {
				if (drag === null) return;
				const dx = event.clientX - drag.x;
				// @approved Capture only once it is a drag, so a tap keeps its card as the click target.
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
				setDrag(null);
				const first = samples.current[0];
				if (press.current !== "drag" || first === undefined) return;
				const speed = (event.clientX - first.x) / Math.max(1, event.timeStamp - first.t);
				setPosition(clamp(Math.round(position - speed * FLICK_MS / CARD_STEP)));
			}}
			onPointerCancel={() => {
				press.current = null;
				setDrag(null);
				setPosition(front);
			}}
			onClickCapture={(event) => {
				if (press.current !== "tap") event.stopPropagation();
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
						<div
							key={variant.id}
							ref={(node) => { cards.current[index] = node; }}
							className="variant-card"
							role="button"
							tabIndex={index === front ? 0 : -1}
							aria-label={`Swipe ${index + 1} of ${variants.length}`}
							aria-describedby={`${id}-${index}`}
							aria-current={index === shownIndex || undefined}
							data-front={index === front}
							// SAFETY: React passes custom properties through to the style; CSSProperties only lacks their names.
							style={{
								"--offset": offset,
								"--distance": Math.abs(offset),
								"--deal": Math.min(Math.abs(index - shownIndex), 4),
								zIndex: variants.length - Math.round(Math.abs(offset)),
							} as CSSProperties}
							onClick={() => (index === front ? onSelect(index) : setPosition(index))}
							onKeyDown={(event) => {
								if (event.key !== "Enter" && event.key !== " ") return;
								event.preventDefault();
								onSelect(index);
							}}
						>
							<header>
								<span>{index + 1} of {variants.length}</span>
								{index === shownIndex && <span className="variant-card-current">Current</span>}
							</header>
							<div id={`${id}-${index}`} className="variant-card-prose prose" data-empty-variant={variant.empty} inert>
								<Prose text={visibleVariantContent(variant)} streaming={false} />
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
