import { useEffect, useReducer, useState } from "react";
import { ChatInformationPanel } from "../ChatInformationPanel";
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
import type { PrimaryPanel } from "./types";
import { useConversationSession } from "./useConversationSession";
import { useGenerationController } from "./useGenerationController";
import { usePreviewController } from "./usePreviewController";
import { useStoryMessageActions } from "./useStoryMessageActions";
import { useStoryViewport } from "./useStoryViewport";

export function ActiveWritingWorkspace({
	initialWorkspace,
	onNewChat,
	newChatOpen,
	onNewChatClose,
	onNewChatCreated,
	importLaunchChatId,
	onImportLaunched,
}: {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
	onNewChat: () => void;
	newChatOpen: boolean;
	onNewChatClose: () => void;
	onNewChatCreated: () => void;
	importLaunchChatId: string | null;
	onImportLaunched: (conversationId: number) => void;
}) {
	const [story, dispatchStory] = useReducer(reduceStory, undefined, createStoryState);
	const [primaryPanel, setPrimaryPanel] = useState<PrimaryPanel>(null);
	const [chatInfoOpen, setChatInfoOpen] = useState(false);
	const [generationDetailsTarget, setGenerationDetailsTarget] = useState<GenerationDetailsTarget | null>(null);
	const [theme, setTheme] = useState<ThemePreference>("system");
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	const [libraryFocusCharacterId, setLibraryFocusCharacterId] = useState<number | null>(null);

	const session = useConversationSession({ initialWorkspace, story, dispatchStory });
	const generation = useGenerationController({
		conversation: session.conversation,
		story,
		dispatchStory,
		activeChatIdRef: session.activeChatIdRef,
		refreshStory: session.refreshStory,
	});
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

	useEffect(() => {
		const root = document.documentElement;
		if (theme === "system") delete root.dataset.theme;
		else root.dataset.theme = theme;
		return () => {
			delete root.dataset.theme;
		};
	}, [theme]);

	const togglePanel = (panel: Exclude<PrimaryPanel, null>) => {
		setChatInfoOpen(false);
		setGenerationDetailsTarget(null);
		setPrimaryPanel((current) => (current === panel ? null : panel));
	};

	const selectChat = (chatId: string) => {
		if (preview.previewPending) return;
		if (
			previewNavigationNeedsConfirmation(story.preview, session.activeChatId, chatId) &&
			!window.confirm("Discard Preview mode and open another Chat?")
		) return;

		dispatchStory({ type: "preview-cancelled" });
		preview.clearPreviewError();
		generation.resetForChatChange();
		session.selectChat(chatId);
		setChatInfoOpen(false);
		setGenerationDetailsTarget(null);
		setPrimaryPanel(null);
	};

	// A just-imported Chat is selected once the refreshed workspace list contains
	// it. Keeping the selection idempotent avoids a transient missing-chat state.
	useEffect(() => {
		if (importLaunchChatId === null || importLaunchChatId === session.activeChatId) return;
		if (initialWorkspace.chats.some((chat) => chat.id === importLaunchChatId)) {
			selectChat(importLaunchChatId);
		}
	}, [importLaunchChatId, session.activeChatId, initialWorkspace.chats]);

	const storyActions = useStoryMessageActions({
		story,
		conversation: session.conversation,
		dispatchStory,
		setConversation: session.setConversation,
		queueSwipeScroll: viewport.queueSwipeScroll,
		clearPreviewError: preview.clearPreviewError,
		onEnterPreview: () => {
			setChatInfoOpen(false);
			setPrimaryPanel(null);
			onNewChatClose();
		},
	});

	const latestStoryMessage = story.messages.at(-1);
	const modelParticipant = session.conversation === null
		? null
		: session.conversation.cast.find((participant) => participant.id === session.conversation?.control.modelParticipantId) ?? null;
	const composerIsReceded = !viewport.isAtLatest && !isComposerFocused;

	const openActiveGenerationDetails = () => {
		if (session.conversation === null || generation.selectedGenerationTarget === undefined) return;
		setChatInfoOpen(false);
		setPrimaryPanel(null);
		setGenerationDetailsTarget({
			type: "active",
			conversationId: session.conversation.id,
			generationId: generation.selectedGenerationTarget.generationId,
		});
	};

	const openVariantDetails = (messageId: number, variantId: number) => {
		if (session.conversation === null) return;
		setChatInfoOpen(false);
		setPrimaryPanel(null);
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
			<NavigationRail activePanel={primaryPanel} onOpenPanel={togglePanel} />

			<PrimaryPanelView
				panel={primaryPanel}
				workspace={initialWorkspace}
				activeChat={session.activeChat}
				theme={theme}
				onThemeChange={setTheme}
				onSelectChat={selectChat}
				onNewChat={onNewChat}
				onClose={() => setPrimaryPanel(null)}
				onImportLaunched={onImportLaunched}
				conversation={session.conversation}
				onConversationChange={session.setConversation}
				libraryFocusCharacterId={libraryFocusCharacterId}
				onLibraryFocusConsumed={() => setLibraryFocusCharacterId(null)}
				onOpenLibraryCharacter={(characterId) => {
					setLibraryFocusCharacterId(characterId);
					setPrimaryPanel("library");
				}}
				mutationsDisabled={story.preview !== null}
			/>

			<main className="story-stage" aria-label="Active Chat" data-preview-mode={story.preview !== null}>
				<StoryHeader
					chat={session.activeChat}
					onOpenCast={() => togglePanel("cast")}
					onOpenInfo={() => {
						if (story.preview !== null) return;
						setGenerationDetailsTarget(null);
						setChatInfoOpen(true);
						setPrimaryPanel(null);
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
									latestStoryMessage?.id === message.id &&
									session.conversation?.playable === true &&
									generation.activeGenerationTargets.length === 0 &&
									isModelAuthoredMessage(message, session.conversation.control.modelParticipantId) &&
									message.continuable === true &&
									!generation.isGenerating &&
									story.preview === null
								}
								onSibling={generation.canOfferSiblingMessage(message) ? generation.siblingMessage : undefined}
								continueLabel={modelParticipant === null ? "Continue" : `Continue as ${modelParticipant.name}`}
								onContinue={generation.continueMessage}
								onInspect={story.preview === null ? openVariantDetails : undefined}
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
					canWrite={session.conversation?.playable === true && !generation.isGenerating && story.preview === null}
					isReceded={composerIsReceded}
					onDraftChange={generation.setDraft}
					onFocusChange={setIsComposerFocused}
					onSubmit={generation.submitMessage}
					onCancel={generation.cancelGeneration}
					stopPending={generation.stopPending}
					controlSelectors={session.conversation !== null ? (
						<ComposerControlSelectors
							conversation={session.conversation}
							disabled={story.preview !== null}
							onConversationChange={session.setConversation}
						/>
					) : null}
				/>
				{generation.generationError !== null && <p className="generation-error" role="alert">{generation.generationError}</p>}
			</main>

			{chatInfoOpen && story.preview === null && (
				<ChatInformationPanel
					conversationId={Number(session.activeChatId)}
					chatTitle={session.activeChat.title}
					onClose={() => setChatInfoOpen(false)}
				/>
			)}
			{generationDetailsTarget !== null && story.preview === null && (
				<GenerationDetailsPanel
					target={generationDetailsTarget}
					onClose={() => setGenerationDetailsTarget(null)}
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
