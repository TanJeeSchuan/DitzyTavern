import { Send } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

export function Composer({
	draft,
	isGenerating,
	canWrite,
	isReceded,
	controlSelectors,
	onDraftChange,
	onFocusChange,
	onSubmit,
}: {
	draft: string;
	isGenerating: boolean;
	canWrite: boolean;
	isReceded: boolean;
	controlSelectors?: ReactNode;
	onDraftChange: (value: string) => void;
	onFocusChange: (focused: boolean) => void;
	onSubmit: (event: FormEvent) => void;
}) {
	return (
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
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
				placeholder="Message storage is not available yet"
				disabled={!canWrite}
				rows={1}
			/>
			<button className="send-button" type="submit" disabled={!canWrite || !draft.trim() || isGenerating} aria-label="Send Message">
				<Send aria-hidden="true" />
			</button>
		</form>
	);
}

