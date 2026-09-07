import { ChevronDown, Info, ListOrdered } from "lucide-react";
import { useState } from "react";
import type { ChatSummary } from "../workspace";
import { PromptPresetDialog } from "./PromptPresetDialog";

export function StoryHeader({
	chat,
	onOpenCast,
	onOpenInfo,
}: {
	chat: ChatSummary;
	onOpenCast: () => void;
	onOpenInfo: () => void;
}) {
	const [presetOpen, setPresetOpen] = useState(false);

	return (
		<header className="story-header">
			<div className="story-title">
				<span>Active Chat</span>
				<h1>{chat.title}</h1>
			</div>
			<button
				className="icon-button chat-info-button labeled-icon-button"
				type="button"
				onClick={() => setPresetOpen(true)}
				aria-label="Prompt Preset"
			>
				<ListOrdered aria-hidden="true" />
			</button>
			<PromptPresetDialog
				conversationId={Number(chat.id)}
				open={presetOpen}
				onOpenChange={setPresetOpen}
			/>
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
