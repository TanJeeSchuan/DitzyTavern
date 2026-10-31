import { boxIdOf } from "../../shared/contract/box";
import { Toast } from "radix-ui";
import { X } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import {
	SaveGuardContext,
	SaveNavigationContext,
	UnsavedChangesDialog,
	useSaveNavigation,
} from "../SaveGuard";
import { ChatInformationPanel } from "../ChatInformationPanel";
import { BoxBoundary } from "../box-windows/BoxBoundary";
import { boxClient, boxPresent } from "../box-windows/registry";
import { BoxOffNotice } from "../box-windows/BoxBlockNotice";
import { useBoxWindows } from "../box-windows/useBoxWindows";
import { PanelHeader } from "../PanelHeader";
import { MacroVariablesPanel } from "../MacroVariablesPanel";
import { PromptPlanPreviewPanel } from "../PromptPlanPreviewPanel";
import { GenerationDetailsPanel } from "../GenerationDetailsPanel";
import {
	createStoryState,
	previewNavigationNeedsConfirmation,
	reduceStory,
} from "../story";
import type { Workspace, ChatSummary, ThemePreference } from "../workspace";
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
import { useNarrow } from "../lib/use-media";
import { useThemePreference } from "../lib/use-theme";
import { useSwipeBrowsing } from "../lib/use-swipe-browsing";
import { GenerationErrorToast } from "./GenerationErrorToast";
import { ControlChangeToaster, type ControlChangeToasterHandle } from "./ControlChangeToaster";
import { StoryStage } from "./StoryStage";
import { CoveredLayer } from "./CoveredLayer";
import { ForkDialog } from "./ForkDialog";
import { forkConversation } from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import type { ForkConversationBody } from "../../shared/contract/conversation-schema";
import { hasMoves } from "../../shared/contract/box-generation";

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
	const [forkAt, setForkAt] = useState<ForkConversationBody["at"] | null>(null);
	const [forkNotice, setForkNotice] = useState<string | null>(null);
	const saveNavigation = useSaveNavigation();
	const [theme, setPersistedTheme] = useThemePreference();
	const [swipeBrowsing, setSwipeBrowsing] = useSwipeBrowsing();

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
		signal: session.signal,
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
		const statusBars = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
		const apply = (preference: ThemePreference) => {
			if (preference === "system") delete root.dataset.theme;
			else root.dataset.theme = preference;
			for (const meta of statusBars) {
				meta.media = preference === "system"
					? `(prefers-color-scheme: ${meta.dataset.theme === "daylight" ? "light" : "dark"})`
					: meta.dataset.theme === preference ? "all" : "not all";
			}
		};
		apply(theme);
		return () => apply("system");
	}, [theme]);

	// @approved
	// Settings stays reachable during Prompt Plan inspection; it cannot change the captured plan.
	const togglePanel = (panel: PrimaryPanelName) => {
		if (assemblyActive && panel !== "settings") return;
		dispatchPanel({ type: "primary-toggled", panel });
	};

	const openChat = (chatId: string, messageId: number | null = null) => {
		dispatchStory({ type: "preview-cancelled" });
		if (chatId !== session.activeChatId) generation.conversationSwitched();
		session.selectChat(chatId, messageId);
		dispatchPanel({ type: "workspace-reset" });
	};
	const selectChat = (chatId: string, messageId: number | null = null) => {
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
		openChat(chatId, messageId);
	};

	const conversation = session.conversation;
	const fork = async (name: string, trimVariants: boolean): Promise<string | null> => {
		if (conversation === null || forkAt === null) return "The Chat is not available.";
		let error: string | null = null;
		const applied = await runConversationCommand({
			conversationId: conversation.id, revision: () => conversation.revision,
			onConversationChange: session.setConversation, setNotice: (notice) => { error = notice; },
			isCurrent: () => !session.signal.aborted,
		}, async (revision) => {
			const result = await forkConversation(conversation.id, { expectedRevision: revision, at: forkAt, name, trimVariants });
			return result.outcome === "available" ? { outcome: "operation", operation: result.value } : result;
		}, { onOperation: (result) => {
			openChat(String(result.conversation.id));
			if (result.rewind) generation.restoreRewind(result.conversation, result.rewind);
			setForkNotice(result.omittedBoxes.length ? `Boxes not copied because they are not installed: ${result.omittedBoxes.join(", ")}.` : null);
			setForkAt(null);
		} });
		return applied ? null : error ?? "The Fork could not be created. Try again.";
	};
	const unlinkFork = () => {
		if (conversation === null) return;
		void runConversationCommand({ conversationId: conversation.id, revision: () => conversation.revision, onConversationChange: session.setConversation, setNotice: setForkNotice, isCurrent: () => !session.signal.aborted }, { type: "unlink-fork" });
	};
	const openForkSource = () => {
		const source = conversation?.forkedFrom;
		if (!source) return;
		saveNavigation.requestNavigation(() => selectChat(String(source.conversationId), source.messageId));
	};
	const boxWindows = useBoxWindows(conversation?.id ?? null);
	const generationDetailsTarget = panelState.generationDetailsTarget;
	const inspectorBox = panelState.detailsSurface === null ? undefined : boxIdOf(panelState.detailsSurface);
	const inspector = inspectorBox === undefined || conversation === null || !boxPresent(conversation, inspectorBox) ? undefined : boxClient(inspectorBox)?.Inspector;
	useEffect(() => {
		if (inspectorBox !== undefined && conversation !== null && !boxPresent(conversation, inspectorBox)) dispatchPanel({ type: "details-closed" });
	}, [conversation, inspectorBox]);

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

	const openBoxInspector = (box: string, focus: { messageId: number } | null) => {
		if (assemblyActive) return;
		dispatchPanel({ type: "box-inspector-opened", box, focus });
	};

	const openVariantDetails = (messageId: number, variantId: number) => {
		if (assemblyActive || session.conversation === null) return;
		dispatchPanel({
			type: "generation-details-opened",
			target: { type: "variant", conversationId: session.conversation.id, messageId, variantId },
		});
	};

	const controlToaster = useRef<ControlChangeToasterHandle>(null);
	// @approved
	// On narrow viewports every panel is a full-screen layer, so the story under it leaves the tab order.
	const narrow = useNarrow();
	const covered = narrow && (panelState.primaryPanel !== null || panelState.detailsSurface !== null || assemblyActive || newChatOpen);

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
			<CoveredLayer inert={narrow && (newChatOpen || panelState.inspector !== null)}>
			<PrimaryPanelView
				panel={panelState.primaryPanel}
				workspace={initialWorkspace}
				activeChat={session.activeChat}
				theme={theme}
				onThemeChange={setPersistedTheme}
				swipeBrowsing={swipeBrowsing}
				onSwipeBrowsingChange={setSwipeBrowsing}
				inspectPromptPlanBeforeGenerating={inspectPromptPlanBeforeGenerating}
				onInspectPromptPlanBeforeGeneratingChange={setInspectPromptPlanBeforeGenerating}
				onSelectChat={(chatId) => saveNavigation.requestNavigation(() => selectChat(chatId))}
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
				onOpenPanel={(panel) => saveNavigation.requestNavigation(() => dispatchPanel({ type: "primary-toggled", panel }))}
				onOpenWindow={boxWindows.open}
			/>
			</CoveredLayer>

			<StoryStage
				story={story}
				dispatchStory={dispatchStory}
				conversation={conversation}
				assemblyActive={assemblyActive}
				inert={covered}
				session={session}
				generation={generation}
				preview={preview}
				boxWindows={boxWindows}
				onFork={(at) => saveNavigation.requestNavigation(() => {
					if ("rewind" in at && (generation.draft.get().trim() !== "" || hasMoves(generation.moves)) && !window.confirm("Replace the current draft and Moves with the rewound Message?")) return;
					setForkAt(at);
				})}
				swipeBrowsing={swipeBrowsing}
				onEnterPreview={() => {
					dispatchPanel({ type: "preview-entered" });
					onNewChatClose();
				}}
				onOpenNavigation={() => setNavigationOpen(true)}
				onOpenCast={() => saveNavigation.requestNavigation(() => togglePanel("characters"))}
				onOpenPanel={(panel) => saveNavigation.requestNavigation(() => dispatchPanel({ type: "primary-toggled", panel }))}
				onOpenInfo={() => {
					if (assemblyActive) return;
					dispatchPanel({ type: "chat-info-opened" });
				}}
				onOpenVariables={() => {
					if (assemblyActive) return;
					dispatchPanel({ type: "macro-variables-opened" });
				}}
				onOpenInspector={openBoxInspector}
				onInspectVariant={openVariantDetails}
				onOpenGenerationDetails={openActiveGenerationDetails}
				onControlChange={(text) => controlToaster.current?.show(text)}
			/>
			</SaveNavigationContext.Provider>
			</SaveGuardContext.Provider>

			<CoveredLayer inert={narrow && (newChatOpen || panelState.primaryPanel !== null)}>
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
			</CoveredLayer>

			<CoveredLayer inert={narrow && newChatOpen}>
			{!assemblyActive && panelState.detailsSurface === "chat-info" && (
				<ChatInformationPanel
					conversationId={Number(session.activeChatId)}
					chatTitle={session.activeChat.title}
					conversation={session.conversation}
					onConversationChange={session.setConversation}
					onOpenForkSource={openForkSource}
					onUnlinkFork={unlinkFork}
					onClose={() => dispatchPanel({ type: "details-closed" })}
				/>
			)}
			{!assemblyActive && inspector !== undefined && inspectorBox !== undefined && session.conversation !== null && (
				<aside className="details-panel" data-open="true" aria-label={inspector.label}>
					<BoxBoundary key={`${session.conversation.id}:${inspectorBox}`} box={inspectorBox}
						fallback={(failure) => <><PanelHeader title={inspector.label} onClose={() => dispatchPanel({ type: "details-closed" })} />{failure}</>}>
						<inspector.Component
							conversation={session.conversation}
							onConversationChange={session.setConversation}
							focusRequest={panelState.boxFocus}
							onClose={() => dispatchPanel({ type: "details-closed" })}
							onNavigateSource={session.navigateToSourceMessage}
							onOpenSettings={() => saveNavigation.requestNavigation(() => dispatchPanel({ type: "primary-opened", panel: `box-settings:${inspectorBox}` }))}
							onOpenConnections={() => saveNavigation.requestNavigation(() => dispatchPanel({ type: "primary-opened", panel: "connections" }))}
						/>
					</BoxBoundary>
					<BoxOffNotice conversation={session.conversation} box={inspectorBox} disabled={story.preview !== null} onConversationChange={session.setConversation} className="m-4 w-auto" />
				</aside>
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
			</CoveredLayer>
			{newChatOpen && <NewChatSurface onCreated={onNewChatCreated} onClose={onNewChatClose} />}
		</div>
		<GenerationErrorToast
			error={generation.generationError}
			imageModel={generation.generationImageModel}
			retry={generation.retryGeneration}
			acknowledge={generation.acknowledgeGenerationError}
		/>
		<ControlChangeToaster ref={controlToaster} />
		{forkNotice !== null && <Toast.Root key={forkNotice} className="workspace-toast" defaultOpen onOpenChange={(open) => { if (!open) setForkNotice(null); }}>
			<Toast.Description className="workspace-toast-description">{forkNotice}</Toast.Description>
			<Toast.Close className="icon-button" aria-label="Dismiss Fork notice"><X aria-hidden="true" /></Toast.Close>
		</Toast.Root>}
		{forkAt !== null && conversation !== null && <ForkDialog name={conversation.name} running={generation.isGenerating || conversation.activeGenerations.length > 0} onClose={() => setForkAt(null)} onFork={fork} />}
		<Toast.Viewport className="toast-viewport" />
		<UnsavedChangesDialog {...saveNavigation.dialogProps} />
		</Toast.Provider>
	);
}
