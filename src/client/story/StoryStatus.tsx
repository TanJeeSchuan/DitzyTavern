import { Square } from "lucide-react";

export function EmptyChat() {
	return (
		<section className="empty-chat">
			<h2>This Chat has no Messages yet.</h2>
			<p>
				New Chats start with the model Participant's opening Message.
				Messages appear here as they are added.
			</p>
		</section>
	);
}

export function HistoryLoading() {
	return (
		<div className="generation-placeholder" role="status" aria-live="polite">
			<div className="placeholder-header">
				<span className="skeleton portrait-skeleton" />
				<span className="skeleton label-skeleton" />
			</div>
			<div className="skeleton prose-skeleton wide" />
			<div className="skeleton prose-skeleton" />
			<span className="sr-only">Loading history</span>
		</div>
	);
}

export function GenerationControls({
	showStopAll,
	pending = false,
	onStop,
	onStopAll,
	onInspect,
}: {
	showStopAll: boolean;
	pending?: boolean;
	onStop: () => void;
	onStopAll: () => void;
	onInspect?: () => void;
}) {
	return (
		<div className="generation-controls" aria-label="Generation controls">
			{onInspect !== undefined && (
				<button className="secondary-button" type="button" onClick={onInspect}>
					Inspect Generation
				</button>
			)}
			<button className="secondary-button" type="button" onClick={onStop} disabled={pending}>
				<Square aria-hidden="true" />
				{pending ? "Stopping…" : "Stop Generation"}
			</button>
			{showStopAll && (
				<button className="secondary-button" type="button" onClick={onStopAll} disabled={pending}>
					Stop All
				</button>
			)}
		</div>
	);
}
