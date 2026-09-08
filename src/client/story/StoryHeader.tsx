import { ChevronDown, Info } from "lucide-react";
import type { ChatSummary } from "../workspace";

export function StoryHeader({
	chat,
	onOpenCast,
	onOpenInfo,
}: {
	chat: ChatSummary;
	onOpenCast: () => void;
	onOpenInfo: () => void;
}) {
	return (
		<header className="story-header">
			<div className="story-title">
				<span>Active Chat</span>
				<h1>{chat.title}</h1>
			</div>
			<button
				className="icon-button chat-info-button"
				type="button"
				onClick={onOpenInfo}
				aria-label="Chat information"
			>
				<Info aria-hidden="true" />
			</button>
			<button className="cast-control" type="button" onClick={onOpenCast}>
				<span>Cast</span>
				<ChevronDown aria-hidden="true" />
			</button>
		</header>
	);
}

