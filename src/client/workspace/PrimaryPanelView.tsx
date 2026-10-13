import type { PromptBoxReference } from "../../shared/contract/box";
import { boxClients, boxPanels, boxTitle } from "../box-windows/registry";
import { CharactersPanel } from "../characters/CharactersPanel";
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
import type { GenerationPanelDraft } from "./GenerationPanel";
import type { SplitInspector } from "./panel-coordination";
import type { PrimaryPanel } from "./types";

// @approved
//  Panels that share the parent-rendered header state their title here. Chats,
// Prompt Presets, and Lorebooks render their own header (those panels own the
// unsaved-edit close guard), so they are excluded by the type rather than by a
// branch at the render site.
const sharedHeaderTitles = {
	characters: "Characters",
	connections: "Connections",
	generation: "Generation Settings",
	settings: "Settings",
} satisfies Record<Exclude<PrimaryPanel, "chats" | "prompts" | "lorebooks" | PromptBoxReference | `box-settings:${string}` | null>, string>;
const isBoxSettings = (panel: PrimaryPanel): panel is `box-settings:${string}` => panel?.startsWith("box-settings:") === true;
const isBoxPanel = (panel: PrimaryPanel): panel is PromptBoxReference => panel?.startsWith("box:") === true;

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
	onActiveChatDeleted,
	conversation,
	onConversationChange,
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
	onActiveChatDeleted: () => void;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	connectionSettings: ConnectionSettingsController;
	generationSettings: GenerationPanelDraft;
	onOpenInspector: (inspector: SplitInspector) => void;
	mutationsDisabled?: boolean;
}) {
	const settingsBox = isBoxSettings(panel) ? panel.slice("box-settings:".length) : undefined;
	const BoxSettings = settingsBox === undefined ? undefined : boxClients.get(settingsBox)?.Settings;
	const box = isBoxPanel(panel) ? panel.slice("box:".length) : undefined;
	const BoxPanel = box === undefined || conversation?.boxes[box] !== "enabled" ? undefined : boxPanels.get(box)?.Panel;
	const headerTitle = panel === null || panel === "chats" || panel === "prompts" || panel === "lorebooks"
		? undefined
		: isBoxSettings(panel) ? boxTitle(panel.slice("box-settings:".length)) : isBoxPanel(panel) ? boxTitle(panel.slice("box:".length)) : sharedHeaderTitles[panel];
	return (
		<aside
			className="primary-panel"
			data-open={Boolean(panel)}
			data-preview-locked={mutationsDisabled}
			aria-hidden={!panel}
		>
			{/* @approved The Chats host stays mounted across panel toggles so the staged
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
				onConversationChange={onConversationChange}
				onActiveChatDeleted={onActiveChatDeleted}
			/>
			{panel !== null && panel !== "chats" && (
				<>
					{headerTitle !== undefined && (
						<PanelHeader title={headerTitle} onClose={onClose} />
					)}
					{BoxPanel !== undefined && conversation !== null && (
						<BoxPanel
							key={conversation.id}
							conversation={conversation}
							onConversationChange={onConversationChange}
							disabled={mutationsDisabled}
						/>
					)}
					{panel === "characters" && (
						<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
							<CharactersPanel
								key={activeChat.id}
								conversation={conversation}
								onConversationChange={onConversationChange}
							/>
						</div>
					)}
					{panel === "lorebooks" && (
						<div className="panel-fill">
							<LorebookPanel conversationId={Number(activeChat.id)} cast={conversation?.cast ?? []} onClose={onClose} mutationsDisabled={mutationsDisabled} />
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
					{BoxSettings !== undefined && (
						<div className="panel-fill">
							<BoxSettings key={settingsBox} />
						</div>
					)}
					{panel === "connections" && (
						<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
							<ConnectionSettingsPanel controller={connectionSettings} activeProfileId={generationSettings.settings?.connectionProfileId ?? null} />
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
