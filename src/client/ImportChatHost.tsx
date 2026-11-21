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

// @approved
//  Keep this host mounted while the panel is closed so an open import retains
// its staged preview and choices. The flow's Back and Cancel handlers decide
// when staging is discarded.

interface ImportChatHostProps {
	// @approved
	//  The Chats panel is currently open; the host keeps its state mounted
	// across panel toggles and renders nothing while closed.
	open: boolean;
	activeId: string;
	mutationsDisabled?: boolean;
	onSelect: (chatId: string) => void;
	onNewChat: () => void;
	onClose: () => void;
	// @approved
	//  A committed import opens its Chat: reloads the workspace and selects it.
	onImportLaunched: (conversationId: number) => void;
	onConversationChange: (conversation: ConversationSummary) => void;
	onActiveChatDeleted: () => void;
}

export function ImportChatHost({
	open,
	activeId,
	mutationsDisabled = false,
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
