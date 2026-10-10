import { useState, type Dispatch } from "react";
import type { ConversationSummary } from "../conversation";
import { ComposerControlSelectors } from "../ComposerControls";
import {
	displayedVariantId,
	isModelAuthoredMessage,
	isPreviewDownstream,
	reusesTrailingHumanMessage,
	type StoryAction,
	type StoryState,
} from "../story";
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
	session,
	generation,
	preview,
	onEnterPreview,
	onOpenNavigation,
	onOpenCast,
	onOpenAuthorNote,
	onOpenInfo,
	onOpenVariables,
	onOpenMemories,
	onInspectVariant,
	onOpenMessageMemories,
	onOpenGenerationDetails,
	onControlChange,
}: {
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
	conversation: ConversationSummary | null;
	assemblyActive: boolean;
	session: ReturnType<typeof useConversationSession>;
	generation: ReturnType<typeof useGenerationController>;
	preview: ReturnType<typeof usePreviewController>;
	onEnterPreview: () => void;
	onOpenNavigation: () => void;
	onOpenCast: () => void;
	onOpenAuthorNote: () => void;
	onOpenInfo: () => void;
	onOpenVariables: () => void;
	onOpenMemories: () => void;
	onInspectVariant: (messageId: number, variantId: number) => void;
	onOpenMessageMemories: (messageId: number) => void;
	onOpenGenerationDetails: () => void;
	onControlChange: (text: string) => void;
}) {
	const viewport = useStoryViewport({
		messages: story.messages,
		conversationId: story.conversationId,
		hasNewer: story.page?.hasNewer === true,
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
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	const composerIsReceded = !viewport.isAtLatest && !isComposerFocused && !generation.isGenerating;
	const latestStoryMessage = story.page?.hasNewer ? undefined : story.messages.at(-1);
	const previewMode = story.preview !== null;
	const previewedMessage = story.messages.find((message) => message.id === story.preview?.messageId);
	const previewSwipeIndex = previewedMessage?.swipes.findIndex((swipe) => swipe.id === story.preview?.variantId) ?? -1;
	const modelParticipant = conversation === null
		? null
		: conversation.cast.find((participant) => participant.id === conversation.control.modelParticipantId) ?? null;
	const humanParticipant = conversation?.cast.find((participant) => participant.id === conversation.control.humanParticipantId) ?? null;
	const requested = story.page?.hasNewer ? null : story.requestedGeneration?.request ?? null;

	return (
		<main className="story-stage" aria-label="Active Chat">
			<StoryHeader
				chat={session.activeChat}
				onOpenNavigation={onOpenNavigation}
				onOpenCast={onOpenCast}
				onOpenInfo={onOpenInfo}
				onOpenVariables={onOpenVariables}
				onOpenMemories={onOpenMemories}
			/>

			{story.preview !== null && previewedMessage !== undefined && (
			<div className="preview-dock" role="status" aria-label="Swipe preview">
				<div className="preview-dock-copy">
					<strong>Previewing Swipe {previewSwipeIndex + 1} of {previewedMessage.swipes.length}</strong>
					<span>Message {story.preview.targetPosition} · Later Messages dimmed</span>
				</div>
				<div className="preview-dock-actions">
					<button className="primary-button" type="button" onClick={() => void preview.confirmPreview()}>Confirm</button>
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
							portrait={conversation?.cast.find((participant) => participant.id === message.authorParticipantId)?.portrait}
							isLatest={latestStoryMessage?.id === message.id}
							generationActive={generation.activeGenerationTargets.some((target) =>
								target.messageId === message.id &&
								target.variantId === displayedVariantId(message, story.preview, story.requestedSelection)
							)}
							generationRequested={requested?.kind === "sibling" && requested.messageId === message.id}
							displayedVariantId={displayedVariantId(message, story.preview, story.requestedSelection)}
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
							onInspect={onInspectVariant}
							onMemories={onOpenMessageMemories}
							generationControls={generation.isGenerating && generation.selectedGenerationTarget?.messageId === message.id && (
								<GenerationControls
									showStopAll={generation.activeGenerationTargets.length > 1}
									pending={generation.stopPending}
									onStopAll={() => void generation.stopAllGenerations()}
									onInspect={onOpenGenerationDetails}
								/>
							)}
							onMoveSwipe={(messageId, direction) => void storyActions.changeSwipe(messageId, direction)}
							onEdit={storyActions.editStoryMessage}
							onDelete={!assemblyActive && !generation.isGenerating
								? (messageId) => void storyActions.deleteStoryMessage(messageId)
								: undefined}
						/>
					))}
					{requested !== null && requested.kind !== "sibling" && humanParticipant !== null && modelParticipant !== null && (
						<RequestedSendView
							human={humanParticipant}
							content={requested.kind === "send" && !reusesTrailingHumanMessage(story, humanParticipant.id, requested.content) ? requested.content : null}
							model={modelParticipant}
						/>
					)}
					{story.page?.hasNewer === true && (
						<div className="history-load-more">
							<button className="secondary-button" type="button" disabled={story.status === "loading-more"} onClick={() => void session.loadMoreHistory("newer")}>
								{story.status === "loading-more" ? "Loading newer Messages…" : "Load newer Messages"}
							</button>
						</div>
					)}
					{story.status === "loading-first" && <HistoryLoading />}
					{story.status === "error" && (
						<p className="history-error" role="alert">
							The Chat history could not be loaded. Try opening the Chat again.
						</p>
					)}
				</div>
			</div>

			{story.page?.hasNewer && <div className="absolute bottom-36 left-1/2 z-10 -translate-x-1/2">
				<button
					className="secondary-button"
					type="button"
					disabled={previewMode}
					onClick={() => void session.jumpToLatest().catch(() => dispatchStory({ type: "history-failed" }))}
				>
					Jump to latest
				</button>
			</div>}
			<Composer
				draft={generation.draft}
				isGenerating={generation.isGenerating}
				canWrite={generation.assemblyAvailable}
				isReceded={composerIsReceded}
				onDraftChange={generation.setDraft}
				onFocusChange={setIsComposerFocused}
				onSubmit={generation.submitMessage}
				onCancel={generation.cancelGeneration}
				stopPending={generation.stopPending || generation.selectedGenerationTarget === undefined}
				writerName={conversation?.cast.find((participant) => participant.id === conversation.control.humanParticipantId)?.duplicateLabel}
				controlSelectors={session.conversation !== null ? (
					<ComposerControlSelectors
						onAuthorNote={onOpenAuthorNote}
						conversation={session.conversation}
						disabled={story.preview !== null || assemblyActive}
						disabledReason={story.preview !== null ? "Confirm or cancel the Swipe preview to change the model." : assemblyActive ? "Close the Prompt Plan preview to change the model." : undefined}
						onConversationChange={session.setConversation}
						onControlChange={onControlChange}
					/>
				) : null}
			/>
		</main>
	);
}
