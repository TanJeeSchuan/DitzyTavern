import { useEffect, useReducer, useState } from "react";
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
	const [theme, setTheme] = useState<ThemePreference>("system");
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	const [libraryFocusCharacterId, setLibraryFocusCharacterId] = useState<number | null>(null);

	const session = useConversationSession({ initialWorkspace, story, dispatchStory });
	const connectionSettings = useConnectionSettingsController();
	const activeConnectionProfile = connectionSettings.settings?.profiles.find(
		(profile) => profile.id === connectionSettings.settings?.activeProfileId,
	);
	const generationSettings = useGenerationSettingsDraft({
		conversation: session.conversation,
		onConversationChange: (conversation) => session.setConversation(conversation),
		transmittingNamespace: connectionSettings.settings === null
			? undefined
			: activeConnectionProfile?.apiFormat ?? null,
	});
	const generation = useGenerationController({
		conversation: session.conversation,
		story,
		dispatchStory,
		activeChatIdRef: session.activeChatIdRef,
		refreshStory: session.refreshStory,
	});
	const assembly = generation.assembly;
	const assemblyActive = assembly !== null;

	useEffect(() => {
		if (assemblyActive) {
			setGenerationDetailsTarget(null);
			dispatchPanel({ type: "assembly-entered" });
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
		<div className="workspace" data-ambience="coral">
			<div className="ambient-field" aria-hidden="true" />
			<NavigationRail activePanel={assemblyActive ? null : panelState.primaryPanel} onOpenPanel={togglePanel} />

			<PrimaryPanelView
				panel={assemblyActive ? null : panelState.primaryPanel}
				workspace={initialWorkspace}
				activeChat={session.activeChat}
				theme={theme}
				onThemeChange={setTheme}
				onSelectChat={selectChat}
				onNewChat={onNewChat}
				onClose={() => dispatchPanel({ type: "primary-closed" })}
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
					controlSelectors={session.conversation !== null ? (
						<ComposerControlSelectors
							conversation={session.conversation}
							disabled={story.preview !== null || assemblyActive}
							onConversationChange={session.setConversation}
						/>
					) : null}
				/>
				{generation.generationError !== null && <p className="generation-error" role="alert">{generation.generationError}</p>}
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
	);
}
