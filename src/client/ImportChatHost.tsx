import { useReducer, useState } from "react";
import { ChatsPanel } from "./ChatsPanel";
import type { ConversationSummary } from "./conversation";
import { ImportChatPanel } from "./ImportChatPanel";
import { discardStagedImport } from "./import-chat";
import {
	createChatImportFlowState,
	reduceChatImportFlow,
} from "./import-chat-flow";
import { PanelHeader } from "./PanelHeader";
import type { ChatSummary } from "./workspace";

// ==[HUMAN APPROVED]== Keep this host mounted while the panel is closed so an open import retains
// its staged preview and choices. The flow's Back and Cancel handlers decide
// when staging is discarded.

interface ImportChatHostProps {
	// ==[HUMAN APPROVED]== The Chats panel is currently open; the host keeps its state mounted
	// across panel toggles and renders nothing while closed.
	open: boolean;
	chats: ChatSummary[];
	activeId: string;
	mutationsDisabled?: boolean;
	// ==[HUMAN APPROVED]== Library Characters the resolver can fork from.
	characters: { id: number; name: string }[];
	onSelect: (chatId: string) => void;
	onNewChat: () => void;
	onClose: () => void;
	// ==[HUMAN APPROVED]== A committed import opens its Chat: reloads the workspace and selects it.
	onImportLaunched: (conversationId: number) => void;
	onConversationChange: (conversation: ConversationSummary) => void;
	onActiveChatDeleted: () => void;
}

export function ImportChatHost({
	open,
	chats,
	activeId,
	mutationsDisabled = false,
	characters,
	onSelect,
	onNewChat,
	onClose,
	onImportLaunched,
	onConversationChange,
	onActiveChatDeleted,
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
			<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
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
			</div>
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
				mutationsDisabled={mutationsDisabled}
				onSelect={onSelect}
				onNewChat={onNewChat}
				onImportChat={openImport}
				onConversationChange={onConversationChange}
				onActiveChatDeleted={onActiveChatDeleted}
			/>
		</>
	);

	function closeImport() {
		setChatsNested("list");
		dispatchImportFlow({ type: "reset" });
	}
}
