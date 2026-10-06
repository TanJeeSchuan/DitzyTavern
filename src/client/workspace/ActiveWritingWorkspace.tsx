import { ArrowLeftRight, CircleAlert, X } from "lucide-react";
import { Toast } from "radix-ui";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { setTextOnlyModel } from "../connection-settings";
import { SaveGuardContext, SaveNavigationContext, UnsavedChangesDialog, type SaveGuard } from "../SaveGuard";
import { ChatInformationPanel } from "../ChatInformationPanel";
import { MemoriesPanel } from "./MemoriesPanel";
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
import { StoryHeader } from "../story/StoryHeader";
import { StoryMessageView } from "../story/StoryMessageView";
import { ProseImageProvider } from "../story/prose";
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
	const [generationDetailsTarget, setGenerationDetailsTarget] = useState<GenerationDetailsTarget | null>(null);
	const [theme, setTheme] = useState<ThemePreference>(() => {
		const saved = window.localStorage.getItem("ditzytavern-theme");
		return saved === "daylight" || saved === "evening" ? saved : "system";
	});
	const [inspectPromptPlanBeforeGenerating, setInspectPromptPlanBeforeGenerating] = useState(
		() => window.localStorage.getItem(PROMPT_PLAN_INSPECTION_KEY) !== "false",
	);
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	const [generationToastOpen, setGenerationToastOpen] = useState(false);
	const [marking, setMarking] = useState(false);
	const [markError, setMarkError] = useState<string | null>(null);
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
		setMarkError(null);
	}, [generation.generationError]);

	const markFailedModelTextOnly = async (retry: boolean) => {
		const model = generation.generationImageModel;
		if (model === null || marking) return;
		setMarking(true);
		setMarkError(null);
		try {
			if (await setTextOnlyModel(model.connectionProfileId, model.modelId, true) === null) {
				setMarkError("The text-only mark could not be saved.");
				return;
			}
			generation.acknowledgeGenerationError();
			if (retry) generation.retryGeneration?.();
		} catch {
			setMarkError("The connection could not be reached.");
		} finally {
			setMarking(false);
		}
	};

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
	const composerIsReceded = !viewport.isAtLatest && !isComposerFocused && !generation.isGenerating;

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

	const previewedMessage = story.messages.find((message) => message.id === story.preview?.messageId);
	const previewSwipeIndex = previewedMessage?.swipes.findIndex((swipe) => swipe.id === story.preview?.variantId) ?? -1;

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

			<main className="story-stage" aria-label="Active Chat">
				<StoryHeader
					chat={session.activeChat}
						onOpenCast={() => requestNavigation(() => togglePanel("characters"))}
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
					onOpenMemories={() => {
						if (assemblyActive) return;
						setGenerationDetailsTarget(null);
						dispatchPanel({ type: "memories-opened" });
					}}
				/>

				{story.preview !== null && previewedMessage !== undefined && (
				<div className="preview-dock" role="status" aria-label="Swipe preview">
					<div className="preview-dock-copy">
						<strong>Previewing Swipe {previewSwipeIndex + 1} of {previewedMessage.swipes.length}</strong>
						<span>Message {story.preview.targetPosition} · Later Messages dimmed</span>
					</div>
					<div className="preview-dock-actions">
						<button className="primary-button" type="button" disabled={preview.previewPending} onClick={() => void preview.confirmPreview()}>Confirm</button>
						<button className="secondary-button" type="button" disabled={preview.previewPending} onClick={preview.cancelPreview}>Cancel</button>
					</div>
					{preview.previewError !== null && <p className="preview-error" role="alert">{preview.previewError}</p>}
				</div>
			)}
				<div className="story-scroll" ref={viewport.storyScrollRef} onScroll={viewport.onStoryScroll}>
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
						<ProseImageProvider key={story.conversationId}>
							{story.messages.map((message) => (
								<StoryMessageView
									key={message.id}
									message={message}
									portrait={conversation?.cast.find((participant) => participant.id === message.authorParticipantId)?.portrait}
									isLatest={latestStoryMessage?.id === message.id}
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
									canRegenerate={
										generation.assemblyAvailable &&
										latestStoryMessage?.id === message.id &&
										generation.activeGenerationTargets.length === 0 &&
										message.authorParticipantId === conversation?.control.humanParticipantId
									}
									onSibling={generation.canOfferSiblingMessage(message)
										? (messageId) => {
											viewport.followLatest(messageId);
											generation.siblingMessage(messageId);
										}
										: undefined}
									continueLabel={modelParticipant === null ? "Continue" : `Continue as ${modelParticipant.name}`}
									onContinue={generation.continueMessage}
									onRegenerate={(messageId) => {
										viewport.followLatest(messageId);
										generation.regenerateResponse(messageId);
									}}
									onInspect={openVariantDetails}
									generationControls={generation.isGenerating && generation.selectedGenerationTarget?.messageId === message.id && (
										<GenerationControls
											showStopAll={generation.activeGenerationTargets.length > 1}
											pending={generation.stopPending}
											onStop={() => void generation.stopGeneration(generation.selectedGenerationTarget!.generationId)}
											onStopAll={() => void generation.stopAllGenerations()}
											onInspect={openActiveGenerationDetails}
										/>
									)}
									onMoveSwipe={(messageId, direction) => void storyActions.changeSwipe(messageId, direction)}
									onEdit={(messageId, content) => void storyActions.editStoryMessage(messageId, content)}
									onDelete={!assemblyActive && !generation.isGenerating
										? (messageId) => void storyActions.deleteStoryMessage(messageId)
										: undefined}
								/>
							))}
						</ProseImageProvider>
						{story.status === "loading-first" && <HistoryLoading />}
						{story.status === "error" && (
							<p className="history-error" role="alert">
								The Chat history could not be loaded. Try opening the Chat again.
							</p>
						)}
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
							disabledReason={story.preview !== null ? "Confirm or cancel the Swipe preview to change the model." : assemblyActive ? "Close the Prompt Plan preview to change the model." : undefined}
							onConversationChange={session.setConversation}
							onControlChange={(text) => setControlChangeToast({ text, id: ++controlToastId.current })}
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
					onNavigateSource={session.navigateToSourceMessage}
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
			{!assemblyActive && panelState.detailsSurface === "memories" && session.conversation !== null && (
				<MemoriesPanel
					key={session.conversation.id}
					conversationId={session.conversation.id}
					conversationRevision={session.conversation.revision}
					onClose={() => dispatchPanel({ type: "details-closed" })}
					onNavigateSource={session.navigateToSourceMessage}
					onOpenPanel={(panel) => requestNavigation(() => dispatchPanel({ type: "primary-opened", panel }))}
				/>
			)}
			{!assemblyActive && panelState.detailsSurface === "generation-details" && generationDetailsTarget !== null && (
				<GenerationDetailsPanel
					target={generationDetailsTarget}
					onNavigateSource={session.navigateToSourceMessage}
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
			{newChatOpen && <NewChatSurface onCreated={onNewChatCreated} onClose={onNewChatClose} />}
		</div>
		{generation.generationError !== null && (
			<Toast.Root
				className="workspace-toast generation-error-toast"
				type="foreground"
				open={generationToastOpen}
				duration={generation.generationImageModel === null ? undefined : Infinity}
				onOpenChange={(open) => {
					setGenerationToastOpen(open);
					if (!open) generation.acknowledgeGenerationError();
				}}
			>
				<div className="workspace-toast-body">
					<div className="workspace-toast-heading"><CircleAlert aria-hidden="true" /><Toast.Title>Generation failed</Toast.Title></div>
					<Toast.Description className="workspace-toast-description">{generation.generationError}</Toast.Description>
					{generation.generationImageModel !== null && <>
						<p className="workspace-toast-description">This Generation sent Images to <span className="font-mono">{generation.generationImageModel.modelId}</span>. If it cannot read Images, mark it text-only to send their names instead.</p>
						{markError !== null && <p className="workspace-toast-description text-destructive" role="alert">{markError}</p>}
						<div className="workspace-toast-actions">
							<Button type="button" size="xs" variant="outline" disabled={marking} onClick={() => void markFailedModelTextOnly(false)}>Mark text-only</Button>
							{generation.retryGeneration !== null && <Button type="button" size="xs" disabled={marking} onClick={() => void markFailedModelTextOnly(true)}>Mark text-only and retry</Button>}
						</div>
					</>}
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
