import { BookOpen, MessageSquare, Plus, Settings2, Upload } from "lucide-react";

export function WorkspaceLoading() {
	return (
		<main className="workspace-loading" aria-busy="true" aria-live="polite">
			<span className="sr-only">Loading workspace</span>
			<div className="loading-rail" />
			<section className="loading-stage">
				<div className="loading-header" />
				<div className="loading-copy">
					<div className="skeleton label-skeleton" />
					<div className="skeleton prose-skeleton wide" />
					<div className="skeleton prose-skeleton" />
				</div>
			</section>
		</main>
	);
}

export function WorkspaceError({ onRetry }: { onRetry: () => void }) {
	return (
		<main className="workspace-error">
			<div>
				<BookOpen aria-hidden="true" />
				<h1>The Chat could not be opened</h1>
				<p>Try again to open the Chat.</p>
				<button className="primary-button" type="button" onClick={onRetry}>Try again</button>
			</div>
		</main>
	);
}

export function WorkspaceWithoutChats({
	onNewChat,
	onImportChat,
	onOpenSettings,
}: {
	onNewChat: () => void;
	onImportChat: () => void;
	onOpenSettings: () => void;
}) {
	return (
		<main className="workspace-empty">
			<div className="workspace-empty-ambience" aria-hidden="true" />
			<section className="workspace-empty-panel" aria-labelledby="workspace-empty-title">
				<header className="workspace-empty-heading">
					<span className="workspace-empty-mark" aria-hidden="true">
						<MessageSquare />
					</span>
					<div>
						<h1 id="workspace-empty-title">No Chats yet</h1>
						<p>Create a Chat with two Participants to open the writing workspace.</p>
					</div>
				</header>
				<div className="workspace-empty-actions">
					<button className="primary-button" type="button" onClick={onNewChat}>
						<Plus aria-hidden="true" /> New Chat
					</button>
					<button className="secondary-button" type="button" onClick={onImportChat}>
						<Upload aria-hidden="true" /> Import Chat
					</button>
				</div>
				<footer className="workspace-empty-footer">
					<button className="workspace-empty-settings" type="button" onClick={onOpenSettings}>
						<Settings2 aria-hidden="true" /> Connection Settings
					</button>
				</footer>
			</section>
		</main>
	);
}

