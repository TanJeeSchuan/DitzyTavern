import { Toast } from "radix-ui";
import { useEffect, useReducer, useRef, useState } from "react";
import {
	SaveGuardContext,
	SaveNavigationContext,
	UnsavedChangesDialog,
	useSaveNavigation,
} from "../SaveGuard";
import { ChatInformationPanel } from "../ChatInformationPanel";
import { MemoriesPanel } from "./MemoriesPanel";
import { MacroVariablesPanel } from "../MacroVariablesPanel";
import { PromptPlanPreviewPanel } from "../PromptPlanPreviewPanel";
import { GenerationDetailsPanel } from "../GenerationDetailsPanel";
import {
	createStoryState,
	previewNavigationNeedsConfirmation,
	reduceStory,
} from "../story";
import type { Workspace, ChatSummary } from "../workspace";
import type { PrimaryPanelName } from "./types";
import { NavigationDrawer, NavigationRail } from "./NavigationRail";
import { NewChatSurface } from "./NewChatSurface";
import { PrimaryPanelView } from "./PrimaryPanelView";
import { useConnectionSettingsController } from "./connection-settings/useConnectionSettingsController";
import { GenerationSettingsInspector } from "./GenerationSettingsInspector";
import {
	createPanelCoordinationState,
	reducePanelCoordination,
	type SplitInspector,
} from "./panel-coordination";
import { useConversationSession } from "./useConversationSession";
import { useGenerationController } from "./useGenerationController";
import { useGenerationSettingsDraft } from "./useGenerationSettingsDraft";
import { usePreviewController } from "./usePreviewController";
import { useThemePreference } from "../lib/use-theme";
import { GenerationErrorToast } from "./GenerationErrorToast";
import { ControlChangeToaster, type ControlChangeToasterHandle } from "./ControlChangeToaster";
import { StoryStage } from "./StoryStage";

const PROMPT_PLAN_INSPECTION_KEY = "ditzytavern.inspect-prompt-plan-before-generating";

export function ActiveWritingWorkspace({
	initialWorkspace,
	onNewChat,
	newChatOpen,
	onNewChatClose,
	onNewChatCreated,
	onImportLaunched,
	onReload,
}: {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
	onNewChat: () => void;
	newChatOpen: boolean;
	onNewChatClose: () => void;
	onNewChatCreated: () => void;
	onImportLaunched: (conversationId: number) => void;
	onReload: () => void;
}) {
	const [story, dispatchStory] = useReducer(reduceStory, undefined, createStoryState);
	const [panelState, dispatchPanel] = useReducer(
		reducePanelCoordination,
		undefined,
		createPanelCoordinationState,
	);
	const [inspectPromptPlanBeforeGenerating, setInspectPromptPlanBeforeGenerating] = useState(
		() => window.localStorage.getItem(PROMPT_PLAN_INSPECTION_KEY) !== "false",
	);
	const [navigationOpen, setNavigationOpen] = useState(false);
	const saveNavigation = useSaveNavigation();
	const [theme, setPersistedTheme] = useThemePreference();

	const session = useConversationSession({ initialWorkspace, story, dispatchStory });
	const connectionSettings = useConnectionSettingsController();
	const generationSettings = useGenerationSettingsDraft({
		conversation: session.conversation,
		onConversationChange: (conversation) => session.setConversation(conversation),
		connectionProfiles: connectionSettings.settings?.profiles,
	});
	const generation = useGenerationController({
		conversation: session.conversation,
		story,
		dispatchStory,
		activeChatIdRef: session.activeChatIdRef,
		refreshStory: session.refreshStory,
		ensureLatest: session.ensureLatest,
		inspectPromptPlanBeforeGenerating,
	});
	const assembly = generation.assembly;
	const assemblyActive = assembly !== null;

	useEffect(() => {
		window.localStorage.setItem(PROMPT_PLAN_INSPECTION_KEY, String(inspectPromptPlanBeforeGenerating));
	}, [inspectPromptPlanBeforeGenerating]);

	useEffect(() => {
		if (assemblyActive) dispatchPanel({ type: "workspace-reset" });
	}, [assemblyActive]);
	const preview = usePreviewController({
		story,
		conversation: session.conversation,
		dispatchStory,
		setConversation: session.setConversation,
	});
	const previewMode = story.preview !== null;

	useEffect(() => {
		dispatchPanel({ type: previewMode ? "preview-entered" : "preview-exited" });
	}, [previewMode]);

	useEffect(() => {
		const root = document.documentElement;
		if (theme === "system") delete root.dataset.theme;
		else root.dataset.theme = theme;
		return () => {
			delete root.dataset.theme;
		};
	}, [theme]);

	// @approved
	// Settings stays reachable during Prompt Plan inspection; it cannot change the captured plan.
	const togglePanel = (panel: PrimaryPanelName) => {
		if (assemblyActive && panel !== "settings") return;
		dispatchPanel({ type: "primary-toggled", panel });
	};

	const selectChat = (chatId: string) => {
		if (preview.previewPending) return;
		// @approved
		//  Workspace chat ids are wire strings; the story read model speaks
		// numeric Conversation ids, so the coercion happens at this boundary.
		if (
			previewNavigationNeedsConfirmation(
				story.preview,
				Number(session.activeChatId),
				Number(chatId),
			) &&
			!window.confirm("Discard Preview mode and open another Chat?")
		) return;

		dispatchStory({ type: "preview-cancelled" });
		preview.clearPreviewError();
		if (chatId !== session.activeChatId) generation.conversationSwitched();
		session.selectChat(chatId);
		dispatchPanel({ type: "workspace-reset" });
	};

	const conversation = session.conversation;
	const generationDetailsTarget = panelState.generationDetailsTarget;
	const memoryFocus = panelState.memoryFocus;

	const openActiveGenerationDetails = () => {
		if (assemblyActive || session.conversation === null || generation.selectedGenerationTarget === undefined) return;
		dispatchPanel({
			type: "generation-details-opened",
			target: {
				type: "active",
				conversationId: session.conversation.id,
				generationId: generation.selectedGenerationTarget.generationId,
			},
		});
	};

	const openMessageMemories = (messageId: number) => {
		if (assemblyActive) return;
		dispatchPanel({ type: "memories-opened", focus: { messageId } });
	};

	const openVariantDetails = (messageId: number, variantId: number) => {
		if (assemblyActive || session.conversation === null) return;
		dispatchPanel({
			type: "generation-details-opened",
			target: { type: "variant", conversationId: session.conversation.id, messageId, variantId },
		});
	};

	const controlToaster = useRef<ControlChangeToasterHandle>(null);

	return (
		<Toast.Provider duration={8_000} swipeDirection="right">
		<div className="workspace" data-ambience="coral">
			<div className="ambient-field" aria-hidden="true" />
			<NavigationRail activePanel={panelState.primaryPanel} inspecting={assemblyActive} onOpenPanel={(panel) => saveNavigation.requestNavigation(() => togglePanel(panel))} />
			<NavigationDrawer
				open={navigationOpen}
				onOpenChange={setNavigationOpen}
				activePanel={panelState.primaryPanel}
				inspecting={assemblyActive}
				onOpenPanel={(panel) => saveNavigation.requestNavigation(() => togglePanel(panel))}
			/>

			<SaveGuardContext.Provider value={saveNavigation.registerSaveGuard}>
			<SaveNavigationContext.Provider value={saveNavigation.requestNavigation}>
			<PrimaryPanelView
				panel={panelState.primaryPanel}
				workspace={initialWorkspace}
				activeChat={session.activeChat}
				theme={theme}
				onThemeChange={setPersistedTheme}
				inspectPromptPlanBeforeGenerating={inspectPromptPlanBeforeGenerating}
				onInspectPromptPlanBeforeGeneratingChange={setInspectPromptPlanBeforeGenerating}
				onSelectChat={selectChat}
				onNewChat={onNewChat}
				onClose={() => saveNavigation.requestNavigation(() => dispatchPanel({ type: "primary-closed" }))}
				onImportLaunched={onImportLaunched}
				onActiveChatDeleted={onReload}
				conversation={session.conversation}
				onConversationChange={session.setConversation}
				connectionSettings={connectionSettings}
				generationSettings={generationSettings}
				onOpenInspector={(inspector: SplitInspector) => {
					if (!assemblyActive) dispatchPanel({ type: "inspector-opened", inspector });
				}}
				mutationsDisabled={story.preview !== null}
			/>
			</SaveNavigationContext.Provider>
			</SaveGuardContext.Provider>

			<StoryStage
				story={story}
				dispatchStory={dispatchStory}
				conversation={conversation}
				assemblyActive={assemblyActive}
				session={session}
				generation={generation}
				preview={preview}
				onEnterPreview={() => {
					dispatchPanel({ type: "preview-entered" });
					onNewChatClose();
				}}
				onOpenNavigation={() => setNavigationOpen(true)}
				onOpenCast={() => saveNavigation.requestNavigation(() => togglePanel("characters"))}
				onOpenAuthorNote={() => saveNavigation.requestNavigation(() => dispatchPanel({ type: "primary-toggled", panel: "author-note" }))}
				onOpenInfo={() => {
					if (assemblyActive) return;
					dispatchPanel({ type: "chat-info-opened" });
				}}
				onOpenVariables={() => {
					if (assemblyActive) return;
					dispatchPanel({ type: "macro-variables-opened" });
				}}
				onOpenMemories={() => {
					if (assemblyActive) return;
					dispatchPanel({ type: "memories-opened", focus: null });
				}}
				onInspectVariant={openVariantDetails}
				onOpenMessageMemories={openMessageMemories}
				onOpenGenerationDetails={openActiveGenerationDetails}
				onControlChange={(text) => controlToaster.current?.show(text)}
			/>

			{assembly !== null && (
				<PromptPlanPreviewPanel
					assembly={assembly}
					onPlanChange={generation.editPromptPlanPreview}
					onRefresh={generation.refreshPromptPlanPreview}
					onSend={generation.sendPromptPlanPreview}
					onNavigateSource={session.navigateToSourceMessage}
					onClose={generation.cancelPromptPlanPreview}
					onOpenSettings={() => saveNavigation.requestNavigation(() => togglePanel("settings"))}
				/>
			)}

			{!assemblyActive && panelState.detailsSurface === "chat-info" && (
				<ChatInformationPanel
					conversationId={Number(session.activeChatId)}
					chatTitle={session.activeChat.title}
					onClose={() => dispatchPanel({ type: "details-closed" })}
				/>
			)}
			{!assemblyActive && panelState.detailsSurface === "memories" && session.conversation !== null && (
				<MemoriesPanel
					key={session.conversation.id}
					conversationId={session.conversation.id}
					conversationRevision={session.conversation.revision}
					cast={session.conversation.cast}
					focusRequest={memoryFocus}
					onClose={() => dispatchPanel({ type: "details-closed" })}
					onNavigateSource={session.navigateToSourceMessage}
					onOpenPanel={(panel) => saveNavigation.requestNavigation(() => dispatchPanel({ type: "primary-opened", panel }))}
				/>
			)}
			{!assemblyActive && panelState.detailsSurface === "generation-details" && generationDetailsTarget !== null && (
				<GenerationDetailsPanel
					target={generationDetailsTarget}
					onNavigateSource={session.navigateToSourceMessage}
					onClose={() => dispatchPanel({ type: "details-closed" })}
				/>
			)}
			{!assemblyActive && panelState.detailsSurface === "macro-variables" && session.conversation !== null && (
				<MacroVariablesPanel
					conversationId={session.conversation.id}
					conversation={session.conversation}
					historyPositions={story.messages.map((message) => message.position)}
					onConversationChange={session.setConversation}
					onClose={() => dispatchPanel({ type: "details-closed" })}
				/>
			)}
			{!assemblyActive && panelState.inspector === "generation" && (
				<GenerationSettingsInspector
					conversation={session.conversation}
					controller={generationSettings}
					onClose={() => dispatchPanel({ type: "inspector-closed" })}
				/>
			)}
			{newChatOpen && <NewChatSurface onCreated={onNewChatCreated} onClose={onNewChatClose} />}
		</div>
		<GenerationErrorToast
			error={generation.generationError}
			imageModel={generation.generationImageModel}
			retry={generation.retryGeneration}
			acknowledge={generation.acknowledgeGenerationError}
		/>
		<ControlChangeToaster ref={controlToaster} />
		<Toast.Viewport className="toast-viewport" />
		<UnsavedChangesDialog {...saveNavigation.dialogProps} />
		</Toast.Provider>
	);
}
