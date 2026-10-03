import { MoreHorizontal, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ConversationSummary } from "./conversation";
import { formatListTime, recencyGroup } from "./lib/format";
import { Portrait } from "./story/Portrait";
import { deleteChat, listChats, renameChat, type ChatSummary } from "./workspace";

export function ChatsPanel({
	chats: initialChats,
	activeId,
	mutationsDisabled = false,
	onSelect,
	onNewChat,
	onImportChat,
	onConversationChange,
	onActiveChatDeleted,
}: {
	chats: ChatSummary[];
	activeId: string;
	mutationsDisabled?: boolean;
	onSelect: (chatId: string) => void;
	onNewChat: () => void;
	onImportChat: () => void;
	onConversationChange: (conversation: ConversationSummary) => void;
	onActiveChatDeleted: () => void;
}) {
	const [chats, setChats] = useState(initialChats);
	const [query, setQuery] = useState("");
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
	const [pending, setPending] = useState(false);
	const renameInput = useRef<HTMLInputElement>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void listChats().then((fresh) => { if (!cancelled) setChats(fresh); }, () => undefined);
		return () => { cancelled = true; };
	}, []);

	const needle = query.trim().toLocaleLowerCase();
	const filtered = chats.filter((chat) => needle === "" || [chat.title, chat.excerpt, ...chat.castNames].some((text) => text.toLocaleLowerCase().includes(needle)));
	const groups = Map.groupBy(filtered, (chat) => recencyGroup(chat.updatedAt));

	const rename = async (chat: ChatSummary, name: string) => {
		setRenamingId(null);
		if (name.trim() === "" || name.trim() === chat.title) return;
		setPending(true);
		const outcome = await renameChat(chat.id, name);
		setPending(false);
		if (outcome.status === "failed") return setNotice(outcome.reason);
		setNotice(null);
		setChats((current) => current.map((item) => item.id === chat.id ? { ...item, title: outcome.conversation.name } : item));
		if (chat.id === activeId) onConversationChange(outcome.conversation);
	};

	const confirmDelete = async (chat: ChatSummary) => {
		setPending(true);
		const failure = await deleteChat(chat.id);
		setPending(false);
		setDeleteTarget(null);
		if (failure !== null) return setNotice(failure);
		setNotice(null);
		if (chat.id === activeId) return onActiveChatDeleted();
		setChats((current) => current.filter((item) => item.id !== chat.id));
	};

	return (
		<div className="panel-body flex flex-col gap-4" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
			<div className="flex items-center gap-2">
				<label className="search-field flex-1">
					<Search aria-hidden="true" />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Chats" aria-label="Search Chats" />
				</label>
				<Button type="button" size="sm" variant="ghost" onClick={onImportChat}><Upload aria-hidden="true" /> Import</Button>
				<Button type="button" size="sm" onClick={onNewChat}><Plus aria-hidden="true" /> New</Button>
			</div>
			{notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
			{filtered.length === 0 && <p className="px-1 text-sm text-muted-foreground">No Chats match this search.</p>}
			{[...groups].map(([group, items]) => (
				<section key={group} className="flex flex-col gap-1" aria-label={group}>
					<h3 className="px-1 text-xs font-medium text-muted-foreground">{group}</h3>
					<ul className="-mx-3 flex flex-col gap-0.5">
						{items.map((chat) => (
							<li key={chat.id} className="group relative flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-muted/40 focus-within:bg-muted/40 data-[active=true]:bg-muted/70" data-active={chat.id === activeId}>
								<CastStack names={chat.castNames} portraits={chat.castPortraits} />
								{renamingId === chat.id ? (
									<input
										ref={renameInput}
										className="field-input min-w-0 flex-1"
										defaultValue={chat.title}
										aria-label="Chat name"
										onFocus={(event) => event.currentTarget.select()}
										onBlur={(event) => void rename(chat, event.currentTarget.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter") event.currentTarget.blur();
											if (event.key === "Escape") setRenamingId(null);
										}}
									/>
								) : (
									<button type="button" className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50" aria-current={chat.id === activeId || undefined} onClick={() => onSelect(chat.id)}>
										<span className="flex items-baseline gap-2">
											<span className="min-w-0 flex-1 truncate text-[0.9rem] font-semibold tracking-[-0.01em]">{chat.title}</span>
											<time className="shrink-0 text-xs text-muted-foreground" dateTime={chat.updatedAt}>{formatListTime(chat.updatedAt)}</time>
										</span>
										<span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{chat.excerpt || "No Messages yet"}</span>
									</button>
								)}
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button type="button" size="icon-xs" variant="ghost" className="relative z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100" disabled={pending} aria-label={`Actions for ${chat.title}`}><MoreHorizontal aria-hidden="true" /></Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-40" onCloseAutoFocus={(event) => { if (renameInput.current !== null) { event.preventDefault(); renameInput.current.focus(); } }}>
										<DropdownMenuItem onSelect={() => setRenamingId(chat.id)}><Pencil aria-hidden="true" /> Rename</DropdownMenuItem>
										<DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(chat)}><Trash2 aria-hidden="true" /> Delete</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</li>
						))}
					</ul>
				</section>
			))}
			<Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !pending) setDeleteTarget(null); }}>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete “{deleteTarget?.title}”?</DialogTitle>
						<DialogDescription>This permanently deletes the Chat with its Messages, Swipes, and Cast. Library Characters are not affected.</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={pending} onClick={() => setDeleteTarget(null)}>Keep Chat</Button>
						<Button type="button" variant="destructive" disabled={pending} onClick={() => { if (deleteTarget !== null) void confirmDelete(deleteTarget); }}>Delete Chat</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function CastStack({ names, portraits }: { names: string[]; portraits: ChatSummary["castPortraits"] }) {
	return (
		<span className="mt-0.5 flex w-[3.65rem] shrink-0 -space-x-2" title={names.join(", ")}>
			{names.slice(0, 3).map((name, index) => <span key={index} className="rounded-[30%] ring-2 ring-(--surface)"><Portrait name={name} portrait={portraits[index]} size="small" /></span>)}
		</span>
	);
}
