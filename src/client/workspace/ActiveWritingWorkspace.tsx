import { ArrowLeftRight, CircleAlert, X } from "lucide-react";
import { Toast } from "radix-ui";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { SaveGuardContext, SaveNavigationContext, UnsavedChangesDialog, type SaveGuard } from "../SaveGuard";
import { ChatInformationPanel } from "../ChatInformationPanel";
import { MacroVariablesPanel } from "../MacroVariablesPanel";
import { PromptPlanPreviewPanel } from "../PromptPlanPreviewPanel";
import {
	GenerationDetailsPanel,
	type GenerationDetailsTarget,
} from "../GenerationDetailsPanel";
import { ComposerControlSelectors } from "../ComposerControls";
import {
	createStoryState,
	displayedVariantId,
	isModelAuthoredMessage,
	isPreviewDownstream,
	previewNavigationNeedsConfirmation,
	reduceStory,
} from "../story";
import { Composer } from "../story/Composer";
import { PreviewIndicator, PreviewNotice } from "../story/PreviewNotice";
import { StoryHeader } from "../story/StoryHeader";
import { StoryMessageView } from "../story/StoryMessageView";
import {
	EmptyChat,
	GenerationControls,
	HistoryLoading,
} from "../story/StoryStatus";
import type {
	ChatSummary,
	ThemePreference,
	Workspace,
} from "../workspace";
import { NavigationRail } from "./NavigationRail";
import { NewChatSurface } from "./NewChatSurface";
import { PrimaryPanelView } from "./PrimaryPanelView";
import { ConnectionSettingsInspector } from "./ConnectionSettingsInspector";
import { useConnectionSettingsController } from "./connection-settings/useConnectionSettingsController";
import { GenerationSettingsInspector } from "./GenerationSettingsInspector";
import {
	createPanelCoordinationState,
	reducePanelCoordination,
	type SplitInspector,
} from "./panel-coordination";
import type { PrimaryPanel } from "./types";
import { useConversationSession } from "./useConversationSession";
import { useGenerationController } from "./useGenerationController";
import { useGenerationSettingsDraft } from "./useGenerationSettingsDraft";
import { usePreviewController } from "./usePreviewController";
import { useStoryMessageActions } from "./useStoryMessageActions";
import { useStoryViewport } from "./useStoryViewport";

const PROMPT_PLAN_INSPECTION_KEY = "ditzytavern.inspect-prompt-plan-before-generating";

export function ActiveWritingWorkspace({
	initialWorkspace,
	onNewChat,
	newChatOpen,
	onNewChatClose,
	onNewChatCreated,
	onImportLaunched,
}: {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
	onNewChat: () => void;
	newChatOpen: boolean;
	onNewChatClose: () => void;
	onNewChatCreated: () => void;
	onImportLaunched: (conversationId: number) => void;
}) {
	const [story, dispatchStory] = useReducer(reduceStory, undefined, createStoryState);
	const [panelState, dispatchPanel] = useReducer(
		reducePanelCoordination,
		undefined,
		createPanelCoordinationState,
	);
	const [generationDetailsTarget, setGenerationDetailsTarget] = useState<GenerationDetailsTarget | null>(null);
	const [theme, setTheme] = useState<ThemePreference>(() => {
		const saved = window.localStorage.getItem("ditzytavern-theme");
		return saved === "daylight" || saved === "evening" ? saved : "system";
	});
	const [inspectPromptPlanBeforeGenerating, setInspectPromptPlanBeforeGenerating] = useState(
		() => window.localStorage.getItem(PROMPT_PLAN_INSPECTION_KEY) !== "false",
	);
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	const [libraryFocusCharacterId, setLibraryFocusCharacterId] = useState<number | null>(null);
	const [generationToastOpen, setGenerationToastOpen] = useState(false);
	const [controlChangeToast, setControlChangeToast] = useState<{ text: string; id: number } | null>(null);
	const controlToastId = useRef(0);
	const saveGuardRef = useRef<SaveGuard | null>(null);
	const [guardPending, setGuardPending] = useState(false);
	const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
	const [leaveSaving, setLeaveSaving] = useState(false);
	const [leaveError, setLeaveError] = useState<string | null>(null);
	const registerSaveGuard = useCallback((guard: SaveGuard | null) => { saveGuardRef.current = guard; setGuardPending(guard?.saving ?? false); }, []);
	const requestNavigation = (action: () => void) => {
		if (saveGuardRef.current?.dirty || saveGuardRef.current?.saving) { setLeaveError(null); setLeaveAction(() => action); }
		else action();
	};
	const saveAndLeave = async () => {
		const guard = saveGuardRef.current;
		if (guard === null || leaveAction === null) return;
		if (!guard.dirty) { const action = leaveAction; setLeaveAction(null); action(); return; }
		setLeaveSaving(true);
		setLeaveError(null);
		try {
			if (await guard.save()) { const action = leaveAction; setLeaveAction(null); action(); }
			else setLeaveError("The changes could not be saved. Keep editing to review them.");
		} catch {
			setLeaveError("The changes could not be saved. Keep editing to review them.");
		} finally { setLeaveSaving(false); }
	};

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
		inspectPromptPlanBeforeGenerating,
	});
	const assembly = generation.assembly;
	const assemblyActive = assembly !== null;

	useEffect(() => {
		if (generation.generationError !== null) setGenerationToastOpen(true);
	}, [generation.generationError]);

	useEffect(() => {
		window.localStorage.setItem(PROMPT_PLAN_INSPECTION_KEY, String(inspectPromptPlanBeforeGenerating));
	}, [inspectPromptPlanBeforeGenerating]);

	useEffect(() => {
		if (assemblyActive) {
			setGenerationDetailsTarget(null);
			dispatchPanel({ type: "workspace-reset" });
		}
	}, [assemblyActive]);
	const viewport = useStoryViewport({
		messages: story.messages,
		conversationId: story.conversationId,
		isGenerating: generation.isGenerating,
	});
	const preview = usePreviewController({
		story,
		conversation: session.conversation,
		dispatchStory,
		setConversation: session.setConversation,
	});
	const previewMode = story.preview !== null;

	useEffect(() => {
		dispatchPanel({ type: previewMode ? "preview-entered" : "preview-exited" });
		if (previewMode) setGenerationDetailsTarget(null);
	}, [previewMode]);

	useEffect(() => {
		const root = document.documentElement;
		if (theme === "system") delete root.dataset.theme;
		else root.dataset.theme = theme;
		return () => {
			delete root.dataset.theme;
		};
	}, [theme]);

	const togglePanel = (panel: Exclude<PrimaryPanel, null>) => {
		if (assemblyActive) return;
		setGenerationDetailsTarget(null);
		dispatchPanel({ type: "primary-toggled", panel });
	};

	const selectChat = (chatId: string) => {
		if (preview.previewPending) return;
		// ==[HUMAN APPROVED]== Workspace chat ids are wire strings; the story read model speaks
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
		generation.conversationSwitched();
		session.selectChat(chatId);
		setGenerationDetailsTarget(null);
		dispatchPanel({ type: "workspace-reset" });
	};

	const storyActions = useStoryMessageActions({
		story,
		conversation: session.conversation,
		dispatchStory,
		setConversation: session.setConversation,
		queueSwipeScroll: viewport.queueSwipeScroll,
		clearPreviewError: preview.clearPreviewError,
		canEnterPreview: !assemblyActive,
		onEnterPreview: () => {
			setGenerationDetailsTarget(null);
			dispatchPanel({ type: "preview-entered" });
			onNewChatClose();
		},
	});

	const latestStoryMessage = story.messages.at(-1);
	const conversation = session.conversation;
	const modelParticipant = conversation === null
		? null
		: conversation.cast.find((participant) => participant.id === conversation.control.modelParticipantId) ?? null;
	const composerIsReceded = !viewport.isAtLatest && !isComposerFocused;

	const openActiveGenerationDetails = () => {
		if (assemblyActive || session.conversation === null || generation.selectedGenerationTarget === undefined) return;
		dispatchPanel({ type: "generation-details-opened" });
		setGenerationDetailsTarget({
			type: "active",
			conversationId: session.conversation.id,
			generationId: generation.selectedGenerationTarget.generationId,
		});
	};

	const openVariantDetails = (messageId: number, variantId: number) => {
		if (assemblyActive || session.conversation === null) return;
		dispatchPanel({ type: "generation-details-opened" });
		setGenerationDetailsTarget({
			type: "variant",
			conversationId: session.conversation.id,
			messageId,
			variantId,
		});
	};

	return (
		<Toast.Provider duration={8_000} swipeDirection="right">
		<div className="workspace" data-ambience="coral">
			<div className="ambient-field" aria-hidden="true" />
			<NavigationRail activePanel={assemblyActive ? null : panelState.primaryPanel} onOpenPanel={(panel) => requestNavigation(() => togglePanel(panel))} />

			<SaveGuardContext.Provider value={registerSaveGuard}>
			<SaveNavigationContext.Provider value={requestNavigation}>
			<PrimaryPanelView
				panel={assemblyActive ? null : panelState.primaryPanel}
				workspace={initialWorkspace}
				activeChat={session.activeChat}
				theme={theme}
				onThemeChange={(value) => { window.localStorage.setItem("ditzytavern-theme", value); setTheme(value); }}
				inspectPromptPlanBeforeGenerating={inspectPromptPlanBeforeGenerating}
				onInspectPromptPlanBeforeGeneratingChange={setInspectPromptPlanBeforeGenerating}
				onSelectChat={selectChat}
				onNewChat={onNewChat}
				onClose={() => requestNavigation(() => dispatchPanel({ type: "primary-closed" }))}
				onImportLaunched={onImportLaunched}
				conversation={session.conversation}
				onConversationChange={session.setConversation}
				libraryFocusCharacterId={libraryFocusCharacterId}
				onLibraryFocusConsumed={() => setLibraryFocusCharacterId(null)}
				onOpenLibraryCharacter={(characterId) => {
					if (assemblyActive) return;
					setLibraryFocusCharacterId(characterId);
					setGenerationDetailsTarget(null);
					dispatchPanel({ type: "primary-opened", panel: "library" });
				}}
				connectionSettings={connectionSettings}
				generationSettings={generationSettings}
				onOpenInspector={(inspector: SplitInspector) => {
					if (!assemblyActive) dispatchPanel({ type: "inspector-opened", inspector });
				}}
				mutationsDisabled={story.preview !== null}
			/>
			</SaveNavigationContext.Provider>
			</SaveGuardContext.Provider>

			<main className="story-stage" aria-label="Active Chat" data-preview-mode={story.preview !== null}>
				<StoryHeader
					chat={session.activeChat}
					onOpenCast={() => togglePanel("cast")}
					onOpenInfo={() => {
						if (assemblyActive) return;
						setGenerationDetailsTarget(null);
						dispatchPanel({ type: "chat-info-opened" });
					}}
					onOpenVariables={() => {
						if (assemblyActive) return;
						setGenerationDetailsTarget(null);
						dispatchPanel({ type: "macro-variables-opened" });
					}}
				/>

				<div className="story-scroll" ref={viewport.storyScrollRef}>
					{story.preview !== null && !story.preview.noticeOpen && (
						<PreviewIndicator
							targetPosition={story.preview.targetPosition}
							onOpen={() => dispatchStory({ type: "preview-notice-opened" })}
						/>
					)}
					<div className="story-content">
						{story.page?.hasOlder === true && (
							<div className="history-load-more">
								<button
									className="secondary-button"
									type="button"
									disabled={story.status === "loading-more"}
									onClick={() => void session.loadMoreHistory()}
								>
									{story.status === "loading-more" ? "Loading more Messages…" : "Load more Messages"}
								</button>
							</div>
						)}
						{story.messages.length === 0 && story.status !== "loading-first" && <EmptyChat />}
						{story.messages.map((message) => (
							<StoryMessageView
								key={message.id}
								message={message}
								generationActive={generation.activeGenerationTargets.some((target) =>
									target.messageId === message.id &&
									target.variantId === displayedVariantId(message, story.preview)
								)}
								displayedVariantId={story.preview?.messageId === message.id ? displayedVariantId(message, story.preview) : undefined}
								mutationsDisabled={story.preview !== null}
								previewDownstream={isPreviewDownstream(message, story.preview)}
								previewTarget={story.preview?.messageId === message.id}
								canContinue={
									generation.assemblyAvailable &&
									latestStoryMessage?.id === message.id &&
									generation.activeGenerationTargets.length === 0 &&
									isModelAuthoredMessage(message) &&
									message.continuable === true
								}
								onSibling={generation.canOfferSiblingMessage(message) ? generation.siblingMessage : undefined}
								continueLabel={modelParticipant === null ? "Continue" : `Continue as ${modelParticipant.name}`}
								onContinue={generation.continueMessage}
								onInspect={openVariantDetails}
								onMoveSwipe={(messageId, direction) => void storyActions.changeSwipe(messageId, direction)}
								onEdit={(messageId, content) => void storyActions.editStoryMessage(messageId, content)}
							/>
						))}
						{story.status === "loading-first" && <HistoryLoading />}
						{story.status === "error" && (
							<p className="history-error" role="alert">
								The Chat history could not be loaded. Try opening the Chat again.
							</p>
						)}
						{generation.isGenerating && generation.activeGenerationTargets.length > 0 && generation.selectedGenerationTarget !== undefined && (
							<GenerationControls
								showStopAll={generation.activeGenerationTargets.length > 1}
								pending={generation.stopPending}
								onStop={() => void generation.stopGeneration(generation.selectedGenerationTarget!.generationId)}
								onStopAll={() => void generation.stopAllGenerations()}
								onInspect={openActiveGenerationDetails}
							/>
						)}
						<div className="latest-anchor" ref={viewport.latestRef} aria-hidden="true" />
					</div>
				</div>

				<Composer
					draft={generation.draft}
					isGenerating={generation.isGenerating}
					canWrite={generation.assemblyAvailable}
					isReceded={composerIsReceded}
					onDraftChange={generation.setDraft}
					onFocusChange={setIsComposerFocused}
					onSubmit={generation.submitMessage}
					onCancel={generation.cancelGeneration}
					stopPending={generation.stopPending}
					writerName={conversation?.cast.find((participant) => participant.id === conversation.control.humanParticipantId)?.duplicateLabel}
					controlSelectors={session.conversation !== null ? (
						<ComposerControlSelectors
							conversation={session.conversation}
							disabled={story.preview !== null || assemblyActive}
							onConversationChange={session.setConversation}
							onControlChange={(text) => setControlChangeToast({ text, id: ++controlToastId.current })}
							onModelSelectionChange={generationSettings.adoptModelSelection}
						/>
					) : null}
				/>
			</main>

			{assembly !== null && (
				<PromptPlanPreviewPanel
					assembly={assembly}
					onPlanChange={generation.editPromptPlanPreview}
					onRefresh={generation.refreshPromptPlanPreview}
					onSend={generation.sendPromptPlanPreview}
					onClose={generation.cancelPromptPlanPreview}
				/>
			)}

			{!assemblyActive && panelState.detailsSurface === "chat-info" && (
				<ChatInformationPanel
					conversationId={Number(session.activeChatId)}
					chatTitle={session.activeChat.title}
					onClose={() => dispatchPanel({ type: "details-closed" })}
				/>
			)}
			{!assemblyActive && panelState.detailsSurface === "generation-details" && generationDetailsTarget !== null && (
				<GenerationDetailsPanel
					target={generationDetailsTarget}
					onClose={() => {
						setGenerationDetailsTarget(null);
						dispatchPanel({ type: "details-closed" });
					}}
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
			{!assemblyActive && panelState.inspector === "models" && (
				<ConnectionSettingsInspector
					controller={connectionSettings}
					onClose={() => dispatchPanel({ type: "inspector-closed" })}
				/>
			)}
			{newChatOpen && <NewChatSurface onCreated={onNewChatCreated} onClose={onNewChatClose} />}
			{story.preview?.noticeOpen && (
				<PreviewNotice
					targetPosition={story.preview.targetPosition}
					pending={preview.previewPending}
					error={preview.previewError}
					onConfirm={() => void preview.confirmPreview()}
					onCancel={preview.cancelPreview}
					onClose={() => dispatchStory({ type: "preview-notice-closed" })}
				/>
			)}
		</div>
		{generation.generationError !== null && (
			<Toast.Root
				className="workspace-toast generation-error-toast"
				type="foreground"
				open={generationToastOpen}
				onOpenChange={(open) => {
					setGenerationToastOpen(open);
					if (!open) generation.acknowledgeGenerationError();
				}}
			>
				<div className="workspace-toast-body">
					<div className="workspace-toast-heading"><CircleAlert aria-hidden="true" /><Toast.Title>Generation failed</Toast.Title></div>
					<Toast.Description className="workspace-toast-description">{generation.generationError}</Toast.Description>
				</div>
				<Toast.Close className="icon-button" aria-label="Dismiss generation error">
					<X aria-hidden="true" />
				</Toast.Close>
			</Toast.Root>
		)}
		{controlChangeToast !== null && (
			<Toast.Root
				key={controlChangeToast.id}
				className="workspace-toast control-change-toast"
				defaultOpen
				duration={3_000}
				onOpenChange={(open) => {
					if (!open) window.setTimeout(() => setControlChangeToast((current) => current?.id === controlChangeToast.id ? null : current), 180);
				}}
			>
				<div className="workspace-toast-body">
					<div className="workspace-toast-heading"><ArrowLeftRight aria-hidden="true" /><Toast.Title>Control changed</Toast.Title></div>
					<Toast.Description className="workspace-toast-description">{controlChangeToast.text}</Toast.Description>
				</div>
				<Toast.Close className="icon-button" aria-label="Dismiss control change"><X aria-hidden="true" /></Toast.Close>
			</Toast.Root>
		)}
		<Toast.Viewport className="toast-viewport" />
		<UnsavedChangesDialog open={leaveAction !== null} saving={leaveSaving || guardPending} error={leaveError} onKeepEditing={() => setLeaveAction(null)} onDiscard={() => { saveGuardRef.current?.discard(); const action = leaveAction; setLeaveAction(null); action?.(); }} onSave={() => void saveAndLeave()} />
		</Toast.Provider>
	);
}
