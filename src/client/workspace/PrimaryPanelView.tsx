import { CastPanel } from "../CastPanel";
import { CharacterLibraryPanel } from "../CharacterLibraryPanel";
import { ImportChatHost } from "../ImportChatHost";
import { PanelHeader } from "../PanelHeader";
import type { ConversationSummary } from "../conversation";
import type {
	ChatSummary,
	ThemePreference,
	Workspace,
} from "../workspace";
import { SettingsPanel } from "./SettingsPanel";
import type { PrimaryPanel } from "./types";

export function PrimaryPanelView({
	panel,
	workspace,
	activeChat,
	theme,
	onThemeChange,
	onSelectChat,
	onNewChat,
	onClose,
	onImportLaunched,
	conversation,
	onConversationChange,
	libraryFocusCharacterId,
	onLibraryFocusConsumed,
	onOpenLibraryCharacter,
}: {
	panel: PrimaryPanel;
	workspace: Workspace;
	activeChat: ChatSummary;
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
	onSelectChat: (chatId: string) => void;
	onNewChat: () => void;
	onClose: () => void;
	onImportLaunched: (conversationId: number) => void;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	libraryFocusCharacterId: number | null;
	onLibraryFocusConsumed: () => void;
	onOpenLibraryCharacter: (characterId: number) => void;
}) {
	return (
		<aside className="primary-panel" data-open={Boolean(panel)} aria-hidden={!panel}>
			{/* The Chats host stays mounted across panel toggles so the staged
			    import flow survives; every other panel renders its own header. */}
			<ImportChatHost
				open={panel === "chats"}
				chats={workspace.chats}
				activeId={activeChat.id}
				characters={workspace.characters}
				onSelect={onSelectChat}
				onNewChat={onNewChat}
				onClose={onClose}
				onImportLaunched={onImportLaunched}
			/>
			{panel !== null && panel !== "chats" && (
				<>
					<PanelHeader
						title={
							panel === "cast"
								? "Cast"
								: panel === "library"
									? "Character Library"
									: "Settings"
						}
						onClose={onClose}
					/>
					{panel === "cast" && (
						<CastPanel
							conversationId={Number(activeChat.id)}
							conversation={conversation}
							onConversationChange={onConversationChange}
							onOpenLibraryCharacter={onOpenLibraryCharacter}
						/>
					)}
					{panel === "library" && (
						<CharacterLibraryPanel
							focusCharacterId={libraryFocusCharacterId}
							onFocusConsumed={onLibraryFocusConsumed}
						/>
					)}
					{panel === "settings" && (
						<SettingsPanel theme={theme} onThemeChange={onThemeChange} />
					)}
				</>
			)}
		</aside>
	);
}

