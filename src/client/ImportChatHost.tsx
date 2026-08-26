import { Plus, Search, Upload } from "lucide-react";
import { useReducer, useState } from "react";
import { ImportChatPanel } from "./ImportChatPanel";
import { discardStagedImport } from "./import-chat";
import {
	createChatImportFlowState,
	reduceChatImportFlow,
} from "./import-chat-flow";
import { PanelHeader } from "./PanelHeader";
import type { ChatSummary } from "./workspace";

// Keep this host mounted while the panel is closed so an open import retains
// its staged preview and choices. The flow's Back and Cancel handlers decide
// when staging is discarded.

interface ChatsPanelProps {
	chats: ChatSummary[];
	activeId: string;
	onSelect: (chatId: string) => void;
	onNewChat: () => void;
	onImportChat: () => void;
}
export function ChatsPanel({
	chats,
	activeId,
	onSelect,
	onNewChat,
	onImportChat,
}: ChatsPanelProps) {
	const [query, setQuery] = useState("");
	const filteredChats = chats.filter((chat) =>
		chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
	);

	return (
		<div className="panel-body">
			<div className="chats-actions">
				<button className="secondary-button" type="button" onClick={onImportChat}>
					<Upload aria-hidden="true" /> Import Chat
				</button>
				<button className="secondary-button" type="button" onClick={onNewChat}>
					<Plus aria-hidden="true" /> New Chat
				</button>
			</div>
			<label className="search-field">
				<Search aria-hidden="true" />
				<span className="sr-only">Search Chats</span>
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search Chats"
				/>
			</label>
			<div className="chat-list">
				{filteredChats.map((chat) => (
					<button
						className="chat-list-item"
						data-active={chat.id === activeId}
						type="button"
						key={chat.id}
						onClick={() => onSelect(chat.id)}
					>
						<span>{chat.title}</span>
						<small>{chat.id === activeId ? "Open now" : chat.updatedAt}</small>
					</button>
				))}
			</div>
		</div>
	);
}

interface ImportChatHostProps {
	// The Chats panel is currently open; the host keeps its state mounted
	// across panel toggles and renders nothing while closed.
	open: boolean;
	chats: ChatSummary[];
	activeId: string;
	// Library Characters the resolver can fork from.
	characters: { id: number; name: string }[];
	onSelect: (chatId: string) => void;
	onNewChat: () => void;
	onClose: () => void;
	// A committed import opens its Chat: reloads the workspace and selects it.
	onImportLaunched: (conversationId: number) => void;
}

export function ImportChatHost({
	open,
	chats,
	activeId,
	characters,
	onSelect,
	onNewChat,
	onClose,
	onImportLaunched,
}: ImportChatHostProps) {
	const [chatsNested, setChatsNested] = useState<"list" | "import">("list");
	const [importFlow, dispatchImportFlow] = useReducer(
		reduceChatImportFlow,
		undefined,
		createChatImportFlowState,
	);

	if (!open) return null;

	if (chatsNested === "import") {
		return (
			<ImportChatPanel
				flow={importFlow}
				onDispatch={dispatchImportFlow}
				characters={characters}
				onImportLaunched={(conversationId) => {
					onImportLaunched(conversationId);
					closeImport();
				}}
				onBackToList={() => {
					discardStagedImport(importFlow.handle?.token ?? null);
					closeImport();
				}}
				onClose={() => {
					discardStagedImport(importFlow.handle?.token ?? null);
					closeImport();
				}}
			/>
		);
	}

	const openImport = () => {
		dispatchImportFlow({ type: "begin" });
		setChatsNested("import");
	};

	return (
		<>
			<PanelHeader title="Chats" onClose={onClose} />
			<ChatsPanel
				chats={chats}
				activeId={activeId}
				onSelect={onSelect}
				onNewChat={onNewChat}
				onImportChat={openImport}
			/>
		</>
	);

	function closeImport() {
		setChatsNested("list");
		dispatchImportFlow({ type: "reset" });
	}
}
