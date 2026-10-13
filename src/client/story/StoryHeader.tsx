import { ChevronDown, Info, UsersRound, Variable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { BoxId } from "../../shared/contract/box";
import { boxTitle, boxClients } from "../box-windows/registry";
import type { ConversationSummary } from "../conversation";
import type { ChatSummary } from "../workspace";

const topBarItemLook = "max-w-56 rounded-xl text-[0.78rem] font-semibold text-muted-foreground tabular-nums";

export function StoryHeader({
	chat,
	conversation,
	onOpenNavigation,
	onOpenCast,
	onOpenInfo,
	onOpenVariables,
	onOpenInspector,
	onOpenWindow,
}: {
	chat: ChatSummary;
	conversation: ConversationSummary | null;
	onOpenNavigation: () => void;
	onOpenCast: () => void;
	onOpenInfo: () => void;
	onOpenVariables: () => void;
	onOpenInspector: (box: BoxId, focus: { messageId: number } | null) => void;
	onOpenWindow: (box: BoxId) => void;
}) {
	const items = conversation === null ? [] : [...boxClients].flatMap(([id, { icon: Icon, TopBarItem, Inspector }]) => {
		if (conversation.boxes[id] !== "enabled" || TopBarItem === undefined) return [];
		if (Inspector !== undefined) return [<button key={id} type="button" className="icon-button" aria-label={Inspector.label} onClick={() => onOpenInspector(id, null)}>
			<Icon aria-hidden="true" /><TopBarItem conversation={conversation} />
		</button>];
		return [<Button key={id} type="button" variant="ghost" size="lg" className={topBarItemLook} title={`Open ${boxTitle(id)}`} onClick={() => onOpenWindow(id)}>
			<Icon aria-hidden="true" />
			<span className="sr-only">{boxTitle(id)}: </span>
			<span className="truncate"><TopBarItem conversation={conversation} /></span>
		</Button>];
	});
	return (
		<header className="story-header">
			<button className="brand-mark navigation-button" type="button" onClick={onOpenNavigation} aria-label="Open navigation">
				<img src="/favicon.svg" alt="" />
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
						{conversation !== null && [...boxClients].map(([id, { icon: Icon, Inspector }]) => Inspector && conversation.boxes[id] === "enabled" && (
							<DropdownMenuItem key={id} onSelect={() => onOpenInspector(id, null)}><Icon aria-hidden="true" /> {Inspector.label}</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="story-header-tools" role="group" aria-label="Chat tools">
				{items}
				<button className="icon-button chat-info-button" type="button" onClick={onOpenInfo} aria-label="Chat information"><Info aria-hidden="true" /></button>
				<button className="icon-button" type="button" onClick={onOpenVariables} aria-label="Macro Variables"><Variable aria-hidden="true" /></button>
			</div>
			<button className="cast-control" type="button" onClick={onOpenCast} aria-label="Cast">
				<UsersRound aria-hidden="true" />
				<span>Cast</span>
			</button>
		</header>
	);
}
