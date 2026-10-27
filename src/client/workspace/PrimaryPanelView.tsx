import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { boxIdOf, boxMetadata, type BoxId, type PromptBoxReference } from "../../shared/contract/box";
import { BoxBoundary } from "../box-windows/BoxBoundary";
import { BoxManager } from "../box-windows/BoxManager";
import { boxClient, boxPresent } from "../box-windows/registry";
import { BoxOffNotice } from "../box-windows/BoxBlockNotice";
import { CharactersPanel } from "../characters/CharactersPanel";
import { ImportChatHost } from "../ImportChatHost";
import { PanelHeader } from "../PanelHeader";
import { PromptPresetPanel } from "./PromptPresetPanel";
import type { ConversationSummary } from "../conversation";
import type {
	ChatSummary,
	SwipeBrowsing,
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
import type { PrimaryPanel, PrimaryPanelName } from "./types";

// @approved
//  Panels that share the parent-rendered header state their title here. Chats,
// Prompt Presets, and Lorebooks render their own header (those panels own the
// unsaved-edit close guard), so they are excluded by the type rather than by a
// branch at the render site.
const sharedHeaderTitles = {
	characters: "Characters",
	connections: "Connections",
	generation: "Generation Settings",
	boxes: "Boxes",
	settings: "Settings",
} satisfies Record<Exclude<PrimaryPanel, "chats" | "prompts" | "lorebooks" | PromptBoxReference | `box-settings:${string}` | null>, string>;
const isBoxSettings = (panel: PrimaryPanel): panel is `box-settings:${string}` => panel?.startsWith("box-settings:") === true;
const isBoxPanel = (panel: PrimaryPanel): panel is PromptBoxReference => panel !== null && boxIdOf(panel) !== undefined;
const parsePanel = (panel: PrimaryPanel) => isBoxSettings(panel) ? { kind: "settings", id: panel.slice("box-settings:".length) } as const
	: isBoxPanel(panel) ? { kind: "box", id: boxIdOf(panel) } as const : { kind: "native", panel } as const;

export function PrimaryPanelView({
	panel,
	workspace,
	activeChat,
	theme,
	onThemeChange,
	swipeBrowsing,
	onSwipeBrowsingChange,
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
	onOpenPanel,
	onOpenWindow,
	mutationsDisabled = false,
}: {
	panel: PrimaryPanel;
	workspace: Workspace;
	activeChat: ChatSummary;
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
	swipeBrowsing: SwipeBrowsing;
	onSwipeBrowsingChange: (mode: SwipeBrowsing) => void;
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
	onOpenPanel: (panel: PrimaryPanelName) => void;
	onOpenWindow: (box: BoxId) => void;
	mutationsDisabled?: boolean;
}) {
	const parsed = parsePanel(panel);
	const settingsBox = parsed.kind === "settings" ? parsed.id : undefined;
	const BoxSettings = settingsBox === undefined ? undefined : boxClient(settingsBox)?.Settings;
	const box = parsed.kind === "box" ? parsed.id : undefined;
	const BoxPanel = box === undefined || conversation === null || !boxPresent(conversation, box) ? undefined : boxClient(box)?.PrimaryPanel;
	const headerTitle = parsed.kind !== "native" ? boxMetadata(parsed.id).label
		: parsed.panel === null || parsed.panel === "chats" || parsed.panel === "prompts" || parsed.panel === "lorebooks" ? undefined : sharedHeaderTitles[parsed.panel];
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
					{BoxPanel !== undefined && box !== undefined && conversation !== null && <>
						<Button type="button" size="sm" variant="ghost" className="mx-3 mt-3 w-fit text-muted-foreground" onClick={() => onOpenPanel("boxes")}><ChevronLeft aria-hidden="true" /> Boxes</Button>
						<BoxOffNotice conversation={conversation} box={box} disabled={mutationsDisabled} onConversationChange={onConversationChange} className="mx-5 mt-2 w-auto" />
						<BoxBoundary key={`${conversation.id}:${box}`} box={box}>
							<BoxPanel
								conversation={conversation}
								onConversationChange={onConversationChange}
								disabled={mutationsDisabled}
							/>
						</BoxBoundary>
					</>}
					{panel === "characters" && (
						<div className="panel-fill" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
							<CharactersPanel
								key={activeChat.id}
								conversation={conversation}
								onConversationChange={onConversationChange}
							/>
						</div>
					)}
					{panel === "boxes" && conversation !== null && (
						<BoxManager key={conversation.id} conversation={conversation} disabled={mutationsDisabled} onConversationChange={onConversationChange}
							onOpenPanel={onOpenPanel} onOpenWindow={onOpenWindow} />
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
							swipeBrowsing={swipeBrowsing}
							onSwipeBrowsingChange={onSwipeBrowsingChange}
							inspectPromptPlanBeforeGenerating={inspectPromptPlanBeforeGenerating}
							onInspectPromptPlanBeforeGeneratingChange={onInspectPromptPlanBeforeGeneratingChange}
						/>
					)}
					{BoxSettings !== undefined && settingsBox !== undefined && (
						<div className="panel-fill">
							<BoxBoundary key={settingsBox} box={settingsBox}><BoxSettings /></BoxBoundary>
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
