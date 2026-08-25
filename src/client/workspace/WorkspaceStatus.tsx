import { BookOpen, MessageSquare, Plus } from "lucide-react";

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
				<p>Your story is still safe. Try loading the workspace again.</p>
				<button className="primary-button" type="button" onClick={onRetry}>Try again</button>
			</div>
		</main>
	);
}

export function WorkspaceWithoutChats({
	onNewChat,
	onOpenSettings,
}: {
	onNewChat: () => void;
	onOpenSettings: () => void;
}) {
	return (
		<main className="workspace-error">
			<div>
				<MessageSquare aria-hidden="true" />
				<h1>No Chats found</h1>
				<p>Create a native Chat with two Participants to open the writing workspace.</p>
				<button className="primary-button" type="button" onClick={onNewChat}>
					<Plus aria-hidden="true" /> New Chat
				</button>
				<button className="secondary-button" type="button" onClick={onOpenSettings}>
					Connection Settings
				</button>
			</div>
		</main>
	);
}

