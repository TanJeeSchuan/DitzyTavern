import { isStoryReady } from "../story";
import { BoxMessageActions } from "../box-windows/BoxMessageActions";
import type { Dispatch } from "react";
import { useLayerFocus } from "../lib/use-layer-focus";
import type { PromptBoxReference } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import type { SwipeBrowsing } from "../workspace";
import { ComposerControlSelectors } from "../ComposerControls";
import { BoxWindowLayer } from "../box-windows/BoxWindowLayer";
import type { BoxWindowsController } from "../box-windows/useBoxWindows";
import {
	displayedVariantId,
	isModelAuthoredMessage,
	isPreviewDownstream,
	hasRequestedSwipe,
	reusesTrailingHumanMessage,
	shownMessage,
	type StoryAction,
	type StoryState,
} from "../story";
import { BackgroundImage } from "../ChatBackground";
import { Composer } from "../story/Composer";
import { StoryHeader } from "../story/StoryHeader";
import { RequestedSendView } from "../story/RequestedSendView";
import { StoryMessageView } from "../story/StoryMessageView";
import {
	EmptyChat,
	GenerationControls,
	HistoryLoading,
} from "../story/StoryStatus";
import type { useConversationSession } from "./useConversationSession";
import type { useGenerationController } from "./useGenerationController";
import type { usePreviewController } from "./usePreviewController";
import { useStoryMessageActions } from "./useStoryMessageActions";
import { useStoryViewport } from "./useStoryViewport";

// @approved
// The story stage: header, preview dock, scrollable message list, and
// composer. It owns the viewport scroll state, the message commands, and the
// composer focus; panel coordination and generation remain with the
// workspace, which composes the guarded openers passed in below.
export function StoryStage({
	story,
	dispatchStory,
	conversation,
	assemblyActive,
	inert,
	session,
	generation,
	preview,
	boxWindows,
	swipeBrowsing,
	onEnterPreview,
	onOpenNavigation,
	onOpenCast,
	onOpenPanel,
	onOpenInfo,
	onOpenVariables,
	onOpenInspector,
	onInspectVariant,
	onOpenGenerationDetails,
	onControlChange,
	onFork,
	onOpenForkSource,
	onUnlinkFork,
	narrow,
}: {
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
	conversation: ConversationSummary | null;
	assemblyActive: boolean;
	inert: boolean;
	boxWindows: BoxWindowsController;
	swipeBrowsing: SwipeBrowsing;
	session: ReturnType<typeof useConversationSession>;
	generation: ReturnType<typeof useGenerationController>;
	preview: ReturnType<typeof usePreviewController>;
	onEnterPreview: () => void;
	onOpenNavigation: () => void;
	onOpenCast: () => void;
	onOpenPanel: (panel: PromptBoxReference) => void;
	onOpenInfo: () => void;
	onOpenVariables: () => void;
	onOpenInspector: (box: string, focus: { messageId: number } | null) => void;
	onInspectVariant: (messageId: number, variantId: number) => void;
	onOpenGenerationDetails: () => void;
	onControlChange: (text: string) => void;
	onFork: (at: { through: number; variantId?: number } | { rewind: number }) => void;
	onOpenForkSource: () => void;
	onUnlinkFork: () => void;
	narrow: boolean;
}) {
	const readyStory = isStoryReady(story) ? story : null;
	const storyConversationId = "conversationId" in story ? story.conversationId : null;
	const viewport = useStoryViewport({
		messages: story.messages,
		conversationId: storyConversationId,
		hasNewer: readyStory?.page.hasNewer === true,
	});
	const storyActions = useStoryMessageActions({
		signal: session.signal,
		story,
		conversation,
		dispatchStory,
		setConversation: session.setConversation,
		queueSwipeScroll: viewport.queueSwipeScroll,
		canEnterPreview: !assemblyActive,
		onEnterPreview,
	});
	const onLayerFocus = useLayerFocus(inert);
	const latestStoryMessage = readyStory?.page.hasNewer ? undefined : story.messages.at(-1);
	const previewMode = story.preview !== null;
	const previewedMessage = story.messages.find((message) => message.id === story.preview?.messageId);
	const previewSwipeIndex = previewedMessage?.swipes.findIndex((swipe) => swipe.id === story.preview?.variantId) ?? -1;
	const lens = conversation === null ? undefined : { conversation, open: boxWindows.open };
	const modelParticipant = conversation === null
		? null
		: conversation.cast.find((participant) => participant.id === conversation.control.modelParticipantId) ?? null;
	const humanParticipant = conversation?.cast.find((participant) => participant.id === conversation.control.humanParticipantId) ?? null;
	const requested = readyStory?.page.hasNewer ? null : story.requestedGeneration?.request ?? null;

	return (
		<main className="story-stage" aria-label="Active Chat" inert={inert} onFocus={onLayerFocus}>
			{conversation !== null && conversation.background !== null && <BackgroundImage key={conversation.background} hash={conversation.background} className="story-background" />}
			<StoryHeader
				chat={session.activeChat}
				conversation={conversation}
				onOpenNavigation={onOpenNavigation}
				onOpenCast={onOpenCast}
				onOpenInfo={onOpenInfo}
				onOpenVariables={onOpenVariables}
				onOpenInspector={onOpenInspector}
				onOpenWindow={boxWindows.open}
				onOpenForkSource={onOpenForkSource}
				onUnlinkFork={onUnlinkFork}
				narrow={narrow}
			/>

			{story.preview !== null && previewedMessage !== undefined && (
			<div className="preview-dock" role="status" aria-label="Swipe preview">
				<div className="preview-dock-copy">
					<strong>Previewing Swipe {previewSwipeIndex + 1} of {previewedMessage.swipes.length}</strong>
					<span>Message {story.preview.targetPosition} · Later Messages dimmed</span>
				</div>
				<div className="preview-dock-actions">
					<button className="primary-button" type="button" onClick={() => void preview.confirmPreview()}>Confirm</button>
					<button className="secondary-button" type="button" onClick={() => onFork({ through: story.preview!.messageId, variantId: story.preview!.variantId })}>Fork with this Variant</button>
					<button className="secondary-button" type="button" onClick={preview.cancelPreview}>Cancel</button>
				</div>
			</div>
		)}
			<div className="story-scroll" ref={viewport.storyScrollRef} onScroll={(event) => {
				viewport.onStoryScroll();
				const root = event.currentTarget;
				if (root.scrollHeight - root.scrollTop - root.clientHeight < 48) void session.loadMoreHistory("newer");
			}}>
				<div className="story-content">
					{readyStory?.page.hasOlder === true && (
						<div className="history-load-more">
							<button
								className="secondary-button"
								type="button"
								disabled={readyStory?.loadingMore === true}
								onClick={() => void session.loadMoreHistory()}
							>
								{readyStory?.loadingMore === true ? "Loading more Messages…" : "Load more Messages"}
							</button>
						</div>
					)}
					{story.messages.length === 0 && story.status !== "loading-first" && <EmptyChat />}
					{storyConversationId !== null && story.messages.map((persisted) => [shownMessage(story, persisted), hasRequestedSwipe(story, persisted.id)] as const).map(([message, swiping]) => (
						<StoryMessageView
							key={message.id}
							conversationId={storyConversationId}
							message={message}
							lens={lens}
							swipeBrowsing={swipeBrowsing}
							portrait={conversation?.cast.find((participant) => participant.id === message.authorParticipantId)?.portrait}
							isLatest={latestStoryMessage?.id === message.id}
							generationActive={swiping || generation.activeGenerationTargets.some((target) =>
								target.messageId === message.id &&
								target.variantId === displayedVariantId(message, story.preview, story.requestedSelections)
							)}
							displayedVariantId={displayedVariantId(message, story.preview, story.requestedSelections)}
							mutationsDisabled={story.preview !== null || swiping}
							previewDownstream={isPreviewDownstream(message, story.preview)}
							previewTarget={story.preview?.messageId === message.id}
							onContinue={
								generation.assemblyAvailable &&
								latestStoryMessage?.id === message.id &&
								generation.activeGenerationTargets.length === 0 &&
								isModelAuthoredMessage(message) &&
								message.continuable === true
									? generation.continueMessage
									: undefined
							}
							onRegenerate={
								generation.assemblyAvailable &&
								latestStoryMessage?.id === message.id &&
								generation.activeGenerationTargets.length === 0 &&
								message.authorParticipantId === conversation?.control.humanParticipantId
									? (messageId) => {
										viewport.followLatest(messageId);
										generation.regenerateResponse(messageId);
									}
									: undefined
							}
							onSibling={generation.canOfferSiblingMessage(message)
								? (messageId) => {
									viewport.followLatest(messageId);
									generation.siblingMessage(messageId);
								}
								: undefined}
							onReroll={generation.canOfferSiblingMessage(message) ? (messageId) => generation.siblingMessage(messageId, true) : undefined}
							continueLabel={modelParticipant === null ? "Continue" : `Continue as ${modelParticipant.name}`}
							onInspect={swiping ? undefined : onInspectVariant}
							boxActions={conversation === null ? undefined : <BoxMessageActions conversation={conversation} messageId={message.id} onOpen={onOpenInspector} />}
							generationControls={generation.isGenerating && generation.selectedGenerationTarget?.messageId === message.id && (
								<GenerationControls
									showStopAll={generation.activeGenerationTargets.length > 1}
									pending={generation.stopPending}
									onStopAll={() => void generation.stopAllGenerations()}
									onInspect={onOpenGenerationDetails}
								/>
							)}
							onMoveSwipe={(messageId, direction) => void storyActions.changeSwipe(messageId, direction)}
							onSelectVariant={(messageId, variantId) => void storyActions.selectSwipe(messageId, variantId)}
							onEdit={storyActions.editStoryMessage}
							onFork={(messageId) => onFork({ through: messageId })}
							onRewind={message.authorRole === "human" ? (messageId) => onFork({ rewind: messageId }) : undefined}
							onMovesChange={message.authorParticipantId === conversation?.control.humanParticipantId && !generation.isGenerating
								? (messageId, moves) => void storyActions.setMessageMoves(messageId, moves)
								: undefined}
							onDelete={!assemblyActive && !generation.isGenerating
								? (messageId) => void storyActions.deleteStoryMessage(messageId)
								: undefined}
						/>
					))}
					{requested !== null && requested.kind !== "sibling" && humanParticipant !== null && modelParticipant !== null && (
						<RequestedSendView
							human={humanParticipant}
							sent={requested.kind === "send" && !reusesTrailingHumanMessage(story, humanParticipant.id, requested.content, requested.moves) ? requested : null}
							model={modelParticipant}
							lens={lens}
						/>
					)}
					{readyStory?.page.hasNewer === true && (
						<div className="history-load-more">
							<button className="secondary-button" type="button" disabled={readyStory?.loadingMore === true} onClick={() => void session.loadMoreHistory("newer")}>
								{readyStory?.loadingMore === true ? "Loading newer Messages…" : "Load newer Messages"}
							</button>
						</div>
					)}
					{story.status === "loading-first" && <HistoryLoading />}
					{(story.status === "error" || readyStory?.historyFailed) && (
						<p className="history-error" role="alert">
							The Chat history could not be loaded. Try opening the Chat again.
						</p>
					)}
				</div>
			</div>

			{readyStory?.page.hasNewer && <div className="absolute bottom-36 left-1/2 z-10 -translate-x-1/2">
				<button
					className="secondary-button"
					type="button"
					disabled={previewMode}
					onClick={() => void session.jumpToLatest().catch(() => dispatchStory({ type: "history-failed" }))}
				>
					Jump to latest
				</button>
			</div>}
			<div className="composer-area">
				<BoxWindowLayer
					key={conversation?.id ?? "no-chat"}
					conversation={conversation}
					controller={boxWindows}
					disabled={previewMode || assemblyActive}
					staging={{ moves: generation.moves, onChange: generation.setMoves }}
					onConversationChange={session.setConversation}
				/>
				<Composer
					draft={generation.draft}
					moves={generation.moves}
					onMovesChange={generation.setMoves}
					isGenerating={generation.isGenerating}
					canWrite={generation.assemblyAvailable}
					atLatest={viewport.atLatest}
					onSubmit={generation.submitMessage}
					onCancel={generation.cancelGeneration}
					stopPending={generation.stopPending || generation.selectedGenerationTarget === undefined}
					writerName={humanParticipant?.duplicateLabel}
					controlSelectors={session.conversation !== null ? (
						<ComposerControlSelectors
							key={session.conversation.id}
							onOpenPanel={onOpenPanel}
							onOpenWindow={boxWindows.open}
							conversation={session.conversation}
							disabled={story.preview !== null || assemblyActive}
							disabledReason={story.preview !== null ? "Confirm or cancel the Swipe preview to change the model." : assemblyActive ? "Close the Prompt Plan preview to change the model." : undefined}
							onConversationChange={session.setConversation}
							onControlChange={onControlChange}
						/>
					) : null}
				/>
			</div>
		</main>
	);
}
