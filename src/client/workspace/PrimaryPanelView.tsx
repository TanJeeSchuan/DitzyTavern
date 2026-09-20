import { CastPanel } from "../CastPanel";
import { CharacterLibraryPanel } from "../CharacterLibraryPanel";
import { ImportChatHost } from "../ImportChatHost";
import { PanelHeader } from "../PanelHeader";
import { PromptPresetPanel } from "./PromptPresetPanel";
import type { ConversationSummary } from "../conversation";
import type {
	ChatSummary,
	ThemePreference,
	Workspace,
} from "../workspace";
import { SettingsPanel } from "./SettingsPanel";
import { ConnectionSettingsPanel } from "./ConnectionSettingsPanel";
import { GenerationPanel } from "./GenerationPanel";
import { LorebookPanel } from "./LorebookPanel";
import type { ConnectionSettingsController } from "./connection-settings/useConnectionSettingsController";
import type { GenerationSettingsDraftController } from "./useGenerationSettingsDraft";
import type { SplitInspector } from "./panel-coordination";
import type { PrimaryPanel } from "./types";

// ==[HUMAN APPROVED]== Panels that share the parent-rendered header state their title here. Chats,
// Prompt Presets, and Lorebooks render their own header (those panels own the
// unsaved-edit close guard), so they are excluded by the type rather than by a
// branch at the render site.
const sharedHeaderTitles = {
	cast: "Cast",
	library: "Character Library",
	models: "Model Settings",
	generation: "Generation Settings",
	settings: "Settings",
} satisfies Record<Exclude<PrimaryPanel, "chats" | "prompts" | "lorebooks" | null>, string>;

export function PrimaryPanelView({
	panel,
	workspace,
	activeChat,
	theme,
	onThemeChange,
	inspectPromptPlanBeforeGenerating,
	onInspectPromptPlanBeforeGeneratingChange,
	onSelectChat,
	onNewChat,
	onClose,
	onImportLaunched,
	conversation,
	onConversationChange,
	libraryFocusCharacterId,
	onLibraryFocusConsumed,
	onOpenLibraryCharacter,
	connectionSettings,
	generationSettings,
	onOpenInspector,
	mutationsDisabled = false,
}: {
	panel: PrimaryPanel;
	workspace: Workspace;
	activeChat: ChatSummary;
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
	inspectPromptPlanBeforeGenerating: boolean;
	onInspectPromptPlanBeforeGeneratingChange: (enabled: boolean) => void;
	onSelectChat: (chatId: string) => void;
	onNewChat: () => void;
	onClose: () => void;
	onImportLaunched: (conversationId: number) => void;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	libraryFocusCharacterId: number | null;
	onLibraryFocusConsumed: () => void;
	onOpenLibraryCharacter: (characterId: number) => void;
	connectionSettings: ConnectionSettingsController;
	generationSettings: GenerationSettingsDraftController;
	onOpenInspector: (inspector: SplitInspector) => void;
	mutationsDisabled?: boolean;
}) {
	const headerTitle = panel === null || panel === "chats" || panel === "prompts" || panel === "lorebooks"
		? undefined
		: sharedHeaderTitles[panel];
	return (
		<aside
			className="primary-panel"
			data-open={Boolean(panel)}
			data-preview-locked={mutationsDisabled}
			aria-hidden={!panel}
		>
			{/* ==[HUMAN APPROVED]== The Chats host stays mounted across panel toggles so the staged
			    import flow survives; every other panel renders its own header. */}
			<ImportChatHost
				open={panel === "chats"}
				chats={workspace.chats}
				activeId={activeChat.id}
				mutationsDisabled={mutationsDisabled}
				characters={workspace.characters}
				onSelect={onSelectChat}
				onNewChat={onNewChat}
				onClose={onClose}
				onImportLaunched={onImportLaunched}
			/>
			{panel !== null && panel !== "chats" && (
				<>
					{headerTitle !== undefined && (
						<PanelHeader title={headerTitle} onClose={onClose} />
					)}
					{panel === "cast" && (
						<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
							<CastPanel
								conversationId={Number(activeChat.id)}
								conversation={conversation}
								onConversationChange={onConversationChange}
								onOpenLibraryCharacter={onOpenLibraryCharacter}
							/>
						</div>
					)}
					{panel === "library" && (
						<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
							<CharacterLibraryPanel
								focusCharacterId={libraryFocusCharacterId}
								onFocusConsumed={onLibraryFocusConsumed}
							/>
						</div>
					)}
					{panel === "lorebooks" && (
						<div className="panel-fill">
							<LorebookPanel conversationId={Number(activeChat.id)} onClose={onClose} mutationsDisabled={mutationsDisabled} />
						</div>
					)}
					{panel === "settings" && (
						<SettingsPanel
							theme={theme}
							onThemeChange={onThemeChange}
							inspectPromptPlanBeforeGenerating={inspectPromptPlanBeforeGenerating}
							onInspectPromptPlanBeforeGeneratingChange={onInspectPromptPlanBeforeGeneratingChange}
						/>
					)}
					{panel === "models" && (
						<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
							<ConnectionSettingsPanel controller={connectionSettings} onOpenInspector={() => onOpenInspector("models")} />
						</div>
					)}
					{panel === "prompts" && (
						<div className="panel-fill">
							<PromptPresetPanel
								conversation={conversation}
								onConversationChange={onConversationChange}
								onClose={onClose}
								mutationsDisabled={mutationsDisabled}
							/>
						</div>
					)}
					{panel === "generation" && (
						<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
							<GenerationPanel
								conversation={conversation}
								controller={generationSettings}
								onOpenInspector={() => onOpenInspector("generation")}
							/>
						</div>
					)}
				</>
			)}
		</aside>
	);
}
