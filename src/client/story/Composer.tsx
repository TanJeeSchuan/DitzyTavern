import { PenLine, Send, Square } from "lucide-react";
import { useRef, type FormEvent, type ReactNode } from "react";

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
	const textareaRef = useRef<HTMLTextAreaElement>(null);

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
			className="composer"
			data-disabled={!canWrite}
			data-receded={isReceded}
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
			<label htmlFor="writer-message" className="sr-only">
				Message draft
			</label>
			<textarea
				id="writer-message"
				ref={textareaRef}
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
				placeholder={writerName !== undefined ? `What does ${writerName} do next?` : "Write the next part of the story…"}
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
