import { Brain, ChevronDown, Info, UsersRound, Variable } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ChatSummary } from "../workspace";

export function StoryHeader({
	chat,
	onOpenNavigation,
	onOpenCast,
	onOpenInfo,
	onOpenVariables,
	onOpenMemories,
}: {
	chat: ChatSummary;
	onOpenNavigation: () => void;
	onOpenCast: () => void;
	onOpenInfo: () => void;
	onOpenVariables: () => void;
	onOpenMemories: () => void;
}) {
	return (
		<header className="story-header">
			<button className="brand-mark navigation-button" type="button" onClick={onOpenNavigation} aria-label="Open navigation">
				DT
			</button>
			<div className="story-title">
				<span>Active Chat</span>
				<DropdownMenu>
					<h1>
						<DropdownMenuTrigger className="story-title-trigger">
							<span>{chat.title}</span>
							<ChevronDown aria-hidden="true" />
						</DropdownMenuTrigger>
					</h1>
					<DropdownMenuContent align="start" className="w-48">
						<DropdownMenuItem onSelect={onOpenInfo}><Info aria-hidden="true" /> Chat information</DropdownMenuItem>
						<DropdownMenuItem onSelect={onOpenVariables}><Variable aria-hidden="true" /> Macro Variables</DropdownMenuItem>
						<DropdownMenuItem onSelect={onOpenMemories}><Brain aria-hidden="true" /> Memories</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<button
				className="icon-button chat-info-button"
				type="button"
				onClick={onOpenInfo}
				aria-label="Chat information"
			>
				<Info aria-hidden="true" />
			</button>
			<button
				className="icon-button variables-button"
				type="button"
				onClick={onOpenVariables}
				aria-label="Macro Variables"
			>
				<Variable aria-hidden="true" />
			</button>
			<button className="icon-button memories-button" type="button" onClick={onOpenMemories} aria-label="Memories"><Brain aria-hidden="true" /></button>
			<button className="cast-control" type="button" onClick={onOpenCast} aria-label="Cast">
				<UsersRound aria-hidden="true" />
				<span>Cast</span>
			</button>
		</header>
	);
}
