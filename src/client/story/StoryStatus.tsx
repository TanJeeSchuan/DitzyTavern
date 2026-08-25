export function EmptyChat() {
	return (
		<section className="empty-chat">
			<h2>This Chat has no stored Messages yet</h2>
			<p>
				Native Chats begin with the model Participant's openings as their
				first Message. History appears here as Messages are added.
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
					: <span className="streaming-placeholder">Waiting for visible text</span>}
			</div>
		</article>
	);
}

