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

export function GenerationPlaceholder() {
	return (
		<div className="generation-placeholder" role="status" aria-live="polite">
			<div className="placeholder-header">
				<span className="skeleton portrait-skeleton" />
				<span className="skeleton label-skeleton" />
			</div>
			<div className="skeleton prose-skeleton wide" />
			<div className="skeleton prose-skeleton" />
			<span className="sr-only">Generating Message</span>
		</div>
	);
}

export function PreviewSkeleton({ messageId }: { messageId: number }) {
	return (
		<div
			className="generation-placeholder preview-skeleton"
			data-message-id={messageId}
			role="status"
			aria-label="Downstream Message hidden during Preview mode"
		>
			<div className="placeholder-header">
				<span className="skeleton portrait-skeleton" />
				<span className="skeleton label-skeleton" />
			</div>
			<div className="skeleton prose-skeleton wide" />
			<div className="skeleton prose-skeleton" />
		</div>
	);
}

export function StreamingGeneration({
	content,
	reasoning,
}: {
	content: string;
	reasoning: string;
}) {
	return (
		<article className="story-message streaming-generation" aria-live="polite">
			<header className="message-header">
				<strong>Generating Message</strong>
				<span className="generation-state">Streaming</span>
			</header>
			{reasoning.length > 0 && (
				<details className="streaming-reasoning">
					<summary>Reasoning</summary>
					<div className="prose">{reasoning}</div>
				</details>
			)}
			<div className="prose">
				{content.length > 0
					? content.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>)
					: <span className="streaming-placeholder">Waiting for the model to send text.</span>}
			</div>
		</article>
	);
}

export function GenerationControls({
	showStopAll,
	pending = false,
	onStop,
	onStopAll,
}: {
	showStopAll: boolean;
	pending?: boolean;
	onStop: () => void;
	onStopAll: () => void;
}) {
	return (
		<div className="generation-controls" aria-label="Generation controls">
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
