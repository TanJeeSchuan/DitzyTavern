import { MoreHorizontal, PenLine, Send, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

export function Composer({
	draft,
	isGenerating,
	canWrite,
	isReceded,
	controlSelectors,
	onDraftChange,
	onFocusChange,
	onSubmit,
	onCancel,
	stopPending = false,
	writerName,
}: {
	draft: string;
	isGenerating: boolean;
	canWrite: boolean;
	isReceded: boolean;
	controlSelectors?: ReactNode;
	onDraftChange: (value: string) => void;
	onFocusChange: (focused: boolean) => void;
	onSubmit: (event: FormEvent) => void;
	onCancel?: () => void;
	stopPending?: boolean;
	writerName?: string;
}) {
	const [controlsOpen, setControlsOpen] = useState(false);
	const composerRef = useRef<HTMLFormElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!controlsOpen) return;
		const close = (event: PointerEvent) => {
			if (!(event.target instanceof Node)) return;
			const composer = composerRef.current;
			if (composer?.querySelector(".model-selector")?.contains(event.target)
				|| composer?.querySelector(".composer-more-button")?.contains(event.target)) return;
			setControlsOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [controlsOpen]);

	return (
		<>
		<button
			className="composer-pill"
			type="button"
			data-visible={isReceded}
			tabIndex={isReceded ? 0 : -1}
			aria-hidden={!isReceded}
			onClick={() => {
				onFocusChange(true);
				requestAnimationFrame(() => textareaRef.current?.focus());
			}}
		>
			<PenLine aria-hidden="true" />
			Write
			{writerName !== undefined && <small>as {writerName}</small>}
		</button>
		<form
			ref={composerRef}
			className="composer"
			data-disabled={!canWrite}
			data-receded={isReceded}
			data-controls-open={controlsOpen}
			onSubmit={onSubmit}
			onFocus={() => onFocusChange(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					onFocusChange(false);
				}
			}}
		>
			{controlSelectors !== undefined && (
				<div className="composer-controls-row">{controlSelectors}</div>
			)}
			{controlSelectors !== undefined && (
				<button
					className="composer-more-button"
					type="button"
					aria-label="Composer options"
					aria-expanded={controlsOpen}
					onClick={() => setControlsOpen((open) => !open)}
				>
					<MoreHorizontal aria-hidden="true" />
				</button>
			)}
			<label htmlFor="writer-message" className="sr-only">
				Message draft
			</label>
			<textarea
				id="writer-message"
				ref={textareaRef}
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
				placeholder="Write the next part of the story…"
				disabled={!canWrite}
				rows={1}
			/>
			{isGenerating ? (
				<button className="send-button" type="button" onClick={onCancel} disabled={stopPending} aria-label="Stop Generation">
					<Square aria-hidden="true" />
				</button>
			) : (
				<button className="send-button" type="submit" disabled={!canWrite} aria-label="Generate Variant">
					<Send aria-hidden="true" />
				</button>
			)}
		</form>
		</>
	);
}
