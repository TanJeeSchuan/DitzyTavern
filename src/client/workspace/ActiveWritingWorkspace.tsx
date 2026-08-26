import {
	type FormEvent,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
} from "react";
import { ChatInformationPanel } from "../ChatInformationPanel";
import { ComposerControlSelectors } from "../ComposerControls";
import { chatHistoryTransport } from "../chat-history";
import {
	applyConversationCommand,
	streamConversationReply,
	loadConversation,
	type ConversationSummary,
} from "../conversation";
import {
	createStoryState,
	classifyVariantSelection,
	confirmPreviewSelection,
	deriveRevisionWindow,
	displayedVariantId,
	isPreviewDownstream,
	moveActiveSwipe,
	previewNavigationNeedsConfirmation,
	reduceStory,
} from "../story";
import { Composer } from "../story/Composer";
import { PreviewIndicator, PreviewNotice } from "../story/PreviewNotice";
import { StoryHeader } from "../story/StoryHeader";
import { StoryMessageView } from "../story/StoryMessageView";
import {
	EmptyChat,
	GenerationPlaceholder,
	PreviewSkeleton,
	StreamingGeneration,
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
	const [activeChatId, setActiveChatId] = useState(initialWorkspace.activeChat.id);
	const [primaryPanel, setPrimaryPanel] = useState<PrimaryPanel>(null);
	const [conversation, setConversation] = useState<ConversationSummary | null>(
		null,
	);
	const [chatInfoOpen, setChatInfoOpen] = useState(false);
	const [theme, setTheme] = useState<ThemePreference>("system");
	const [draft, setDraft] = useState("");
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	const [isAtLatest, setIsAtLatest] = useState(true);
	// Set by the Cast drawer after a Participant is saved as a Character;
	// the Library panel opens that entry when it mounts. Consumed once so a
	// later library visit starts at the top-level list again.
	const [libraryFocusCharacterId, setLibraryFocusCharacterId] = useState<
		number | null
	>(null);
	const storyScrollRef = useRef<HTMLDivElement>(null);
	const latestRef = useRef<HTMLDivElement>(null);
	// Scroll anchoring for bottom-pinned reading: tracks the last rendered
	// Message id and scroll height so a freshly opened Chat lands on its
	// newest Messages while prepended older pages keep the viewport still.
	const anchoredLastMessageIdRef = useRef<number | null>(null);
	const anchoredScrollHeightRef = useRef(0);
	const [isGenerating, setIsGenerating] = useState(false);
	const [streamingOutput, setStreamingOutput] = useState({ content: "", reasoning: "" });
	const activeChatIdRef = useRef(activeChatId);
	const generationAbortRef = useRef<AbortController | null>(null);
	const [generationError, setGenerationError] = useState<string | null>(null);
	const [previewPending, setPreviewPending] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const previewConfirmInFlightRef = useRef(false);
	const activeChat =
		initialWorkspace.chats.find((chat) => chat.id === activeChatId) ??
		initialWorkspace.activeChat;
	activeChatIdRef.current = activeChatId;

	useEffect(() => () => {
		generationAbortRef.current?.abort();
		generationAbortRef.current = null;
	}, []);

	useEffect(() => {
		if (story.preview === null) {
			setPreviewPending(false);
			setPreviewError(null);
			previewConfirmInFlightRef.current = false;
		}
	}, [story.preview]);

	useEffect(() => {
		const root = document.documentElement;
		if (theme === "system") {
			delete root.dataset.theme;
		} else {
			root.dataset.theme = theme;
		}
		return () => {
			delete root.dataset.theme;
		};
	}, [theme]);

	useEffect(() => {
		const root = storyScrollRef.current;
		const latest = latestRef.current;
		if (!root || !latest) {
			return;
		}

		const observer = new IntersectionObserver(
			([entry]) => setIsAtLatest(entry.isIntersecting),
			{ root, threshold: 0.5 },
		);
		observer.observe(latest);
		return () => observer.disconnect();
	}, [story.messages.length, isGenerating]);

	// Load the authoritative Conversation snapshot for the active Chat so
	// the Cast drawer and the composer Control selectors reflect real
	// Cast and Control state, never client copies of domain rules.
	useEffect(() => {
		setConversation(null);
		const conversationId = Number(activeChatId);
		if (!Number.isInteger(conversationId) || conversationId <= 0) {
			return;
		}
		let cancelled = false;
		loadConversation(conversationId)
			.then((loaded) => {
				if (!cancelled) setConversation(loaded);
			})
			.catch(() => {
				if (!cancelled) setConversation(null);
			});
		return () => {
			cancelled = true;
		};
	}, [activeChatId]);

	// Load the native history in stable chronological pages: the story reads
	// through the paginated seam, never the full Conversation with all its
	// provenance. A stale response for a Chat the user already left is
	// ignored by the per-Chat cancellation guard.
	useEffect(() => {
		const conversationId = Number(activeChatId);
		if (!Number.isInteger(conversationId) || conversationId <= 0) {
			return;
		}
		dispatchStory({ type: "chat-opened", conversationId });
		setChatInfoOpen(false);
		let cancelled = false;
		void chatHistoryTransport.loadHistory(conversationId, { page: 1 }).then((outcome) => {
			if (cancelled) return;
			if (outcome.status === "available") {
				dispatchStory({ type: "first-page", page: outcome.page });
			} else {
				dispatchStory({ type: "history-failed" });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [activeChatId]);

	// Bottom-pinned reading: a fresh latest window (Chat opened, or the
	// authoritative reload after an edit) pins the view to its newest
	// Messages instantly, before paint. Prepending an older page keeps the
	// last Message id unchanged, so the viewport shifts by exactly the
	// height the prepended content added instead of jumping.
	useLayoutEffect(() => {
		const root = storyScrollRef.current;
		if (!root) return;
		const messages = story.messages;
		if (messages.length === 0) {
			anchoredLastMessageIdRef.current = null;
			anchoredScrollHeightRef.current = root.scrollHeight;
			return;
		}
		const lastId = messages[messages.length - 1].id;
		const prevLastId = anchoredLastMessageIdRef.current;
		const prevHeight = anchoredScrollHeightRef.current;
		anchoredLastMessageIdRef.current = lastId;
		anchoredScrollHeightRef.current = root.scrollHeight;

		if (prevLastId === null || prevLastId !== lastId) {
			root.scrollTop = root.scrollHeight;
			return;
		}
		if (root.scrollHeight > prevHeight) {
			root.scrollTop += root.scrollHeight - prevHeight;
		}
	}, [story.messages, story.conversationId]);

	// A just-imported Chat is selected as soon as the refreshed workspace
	// list contains it; the selection effect is idempotent and never fires
	// for a target that is not yet present.
	useEffect(() => {
		if (importLaunchChatId === null || importLaunchChatId === activeChatId) {
			return;
		}
		const present = initialWorkspace.chats.some(
			(chat) => chat.id === importLaunchChatId,
		);
		if (present) {
			selectChat(importLaunchChatId);
		}
	}, [importLaunchChatId, activeChatId, initialWorkspace.chats]);

	const togglePanel = (panel: Exclude<PrimaryPanel, null>) => {
		setChatInfoOpen(false);
		setPrimaryPanel((current) => (current === panel ? null : panel));
	};

	const selectChat = (chatId: string) => {
		if (previewConfirmInFlightRef.current) return;
		if (
			previewNavigationNeedsConfirmation(story.preview, activeChatId, chatId) &&
			!window.confirm("Discard Preview mode and open another Chat?")
		) {
			return;
		}
		activeChatIdRef.current = chatId;
		dispatchStory({ type: "preview-cancelled" });
		setPreviewError(null);
		generationAbortRef.current?.abort();
		generationAbortRef.current = null;
		setIsGenerating(false);
		setStreamingOutput({ content: "", reasoning: "" });
		setGenerationError(null);
		setActiveChatId(chatId);
		setChatInfoOpen(false);
		setPrimaryPanel(null);
	};

	// Requests the next older page of history and prepends it to the
	// accumulated story; the button stays disabled while a load is in
	// flight. Scroll anchoring keeps the viewport still during prepend.
	const loadMoreHistory = async () => {
		const conversationId = story.conversationId;
		const next = (story.page?.index ?? 0) + 1;
		if (conversationId === null || story.page?.hasOlder !== true) return;
		dispatchStory({ type: "load-more-started" });
		const outcome = await chatHistoryTransport.loadHistory(conversationId, {
			page: next,
		});
		if (outcome.status === "available") {
			dispatchStory({ type: "next-page-arrived", page: outcome.page });
		} else {
			dispatchStory({ type: "history-failed" });
		}
	};

	// Normal swipe navigation: the local position updates immediately (empty
	// and duplicate Variants are separate positions, and an exact empty
	// Variant shows a presentation-only placeholder), then the existing
	// revisioned Variant-selection command persists the selection. A conflict
	// reloads the authoritative state instead of rewriting the plan.
	const changeSwipe = async (messageId: number, direction: -1 | 1) => {
		if (story.preview !== null || conversation === null) return;
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const target = storyMessage.swipes[moveActiveSwipe(storyMessage, direction)];
		if (target === undefined) return;
		const revisionWindow = deriveRevisionWindow(
			story.messages,
			conversation.control.modelParticipantId,
		);
		const selection = classifyVariantSelection(
			story,
			messageId,
			target.id,
			revisionWindow,
		);
		if (selection.kind === "noop" || selection.kind === "blocked") return;
		if (selection.kind === "preview") {
			setChatInfoOpen(false);
			setPrimaryPanel(null);
			onNewChatClose();
			setPreviewError(null);
			dispatchStory({
				type: "preview-started",
				messageId: selection.messageId,
				variantId: selection.variantId,
			});
			return;
		}
		dispatchStory({
			type: "swipe-selected",
			messageId: selection.messageId,
			variantId: selection.variantId,
		});
		const conversationId = story.conversationId;
		if (conversationId === null) return;
		const expectedRevision = conversation?.revision ?? story.revision ?? -1;
		if (expectedRevision < 0) return;
		const outcome = await applyConversationCommand(conversationId, expectedRevision, {
			type: "select-variant",
			messageId: selection.messageId,
			variantId: selection.variantId,
		});
		if (outcome.status === "applied") {
			setConversation(outcome.conversation);
			return;
		}
		// Conflicting revision or transport failure: fall back to the
		// authoritative snapshot so the visible selection never diverges.
		if (outcome.status === "conflict") {
			setConversation(outcome.currentConversation);
		}
		const fresh = await loadConversation(conversationId);
		if (fresh !== null) setConversation(fresh);
	};

	// Normal Message editing: the Edit action persists through the existing
	// revisioned edit-variant command and updates the story locally; only
	// native domain state changes, never either preserved source.
	const editStoryMessage = async (messageId: number, content: string) => {
		if (story.preview !== null) return;
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const variantId = storyMessage.swipes[storyMessage.activeSwipe]?.id;
		if (variantId === undefined) return;
		const conversationId = story.conversationId;
		if (conversationId === null) return;
		const expectedRevision = conversation?.revision ?? story.revision ?? -1;
		if (expectedRevision < 0) return;
		const outcome = await applyConversationCommand(conversationId, expectedRevision, {
			type: "edit-variant",
			messageId,
			variantId,
			content,
		});
		if (outcome.status === "applied") {
			setConversation(outcome.conversation);
			// Reload the first page so the authoritative content replaces the
			// locally edited text without drifting.
			const fresh = await chatHistoryTransport.loadHistory(conversationId, {
				page: 1,
			});
			if (fresh.status === "available") {
				dispatchStory({ type: "first-page", page: fresh.page });
			}
			return;
		}
		if (outcome.status === "conflict") {
			setConversation(outcome.currentConversation);
		}
		const fresh = await loadConversation(conversationId);
		if (fresh !== null) setConversation(fresh);
	};

	const cancelGeneration = () => generationAbortRef.current?.abort();

	const cancelPreview = () => {
		if (previewPending) return;
		setPreviewError(null);
		dispatchStory({ type: "preview-cancelled" });
	};

	const confirmPreview = async () => {
		const preview = story.preview;
		const conversationId = story.conversationId;
		if (preview === null || conversationId === null || previewConfirmInFlightRef.current) {
			return;
		}
		const expectedRevision = conversation?.revision ?? story.revision ?? -1;
		if (expectedRevision < 0) {
			setPreviewError("The Conversation revision is not available yet.");
			return;
		}

		previewConfirmInFlightRef.current = true;
		setPreviewPending(true);
		setPreviewError(null);
		const request = {
			conversationId,
			expectedRevision,
			messageId: preview.messageId,
			variantId: preview.variantId,
		};
		try {
			const result = await confirmPreviewSelection(
				preview,
				request,
				async (selection) =>
					applyConversationCommand(selection.conversationId, selection.expectedRevision, {
						type: "select-variant",
						messageId: selection.messageId,
						variantId: selection.variantId,
					}),
			);
			if (result.status === "not-sent") return;
			const outcome = result.result;
			if (outcome.status === "applied") {
				setConversation(outcome.conversation);
				dispatchStory({ type: "preview-confirmed" });
				return;
			}
			if (outcome.status === "conflict") {
				setConversation(outcome.currentConversation);
				setPreviewError(
					"The Conversation changed elsewhere. Preview remains local until you confirm or cancel it.",
				);
				return;
			}
			if (outcome.status === "not-found") {
				setPreviewError("The Conversation no longer exists.");
				return;
			}
			setPreviewError(
				outcome.status === "network"
					? "The Conversation could not be reached."
					: outcome.reason,
			);
		} catch {
			setPreviewError("The Conversation could not be reached.");
		} finally {
			previewConfirmInFlightRef.current = false;
			setPreviewPending(false);
		}
	};

	const submitMessage = (event: FormEvent) => {
		event.preventDefault();
		if (story.preview !== null || isGenerating || conversation === null || !conversation.playable) return;
		setIsGenerating(true);
		setStreamingOutput({ content: "", reasoning: "" });
		setGenerationError(null);
		const controller = new AbortController();
		generationAbortRef.current = controller;
		const conversationId = conversation.id;
		const requestIsCurrent = () =>
			generationAbortRef.current === controller &&
			Number(activeChatIdRef.current) === conversationId;
		void streamConversationReply(conversationId, {
			signal: controller.signal,
			onDelta: (event) => {
				if (!requestIsCurrent()) return;
				if (event.type === "content") setStreamingOutput((current) => ({ ...current, content: current.content + event.text }));
				if (event.type === "reasoning") setStreamingOutput((current) => ({ ...current, reasoning: current.reasoning + event.text }));
			},
		})
			.then(async (outcome) => {
				if (!requestIsCurrent()) return;
				if (outcome.outcome === "applied") {
					const [freshConversation, freshHistory] = await Promise.all([
						loadConversation(conversationId),
						chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
					]);
					if (!requestIsCurrent()) return;
					if (freshConversation !== null) setConversation(freshConversation);
					if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
					return;
				}
				if (outcome.outcome === "not-found") {
					setGenerationError("The Conversation no longer exists.");
					return;
				}
				setGenerationError(outcome.reason);
			})
			.catch(async () => {
				if (!requestIsCurrent()) return;
				if (controller.signal.aborted) {
					// The server preserves any received partial output as an interrupted
					// Variant before the cancelled request unwinds. Refresh the visible
					// history so cancellation does not discard that writing in the UI.
					const fresh = await chatHistoryTransport.loadHistory(conversationId, { page: 1 });
					if (requestIsCurrent() && fresh.status === "available") dispatchStory({ type: "first-page", page: fresh.page });
					return;
				}
				setGenerationError("Generation could not be completed.");
			})
			.finally(() => {
				if (!requestIsCurrent()) return;
				generationAbortRef.current = null;
				setIsGenerating(false);
				setStreamingOutput({ content: "", reasoning: "" });
			});
	};

	const composerIsReceded = !isAtLatest && !isComposerFocused;

	return (
		<div className="workspace" data-ambience="coral">
			<div className="ambient-field" aria-hidden="true" />
			<NavigationRail
				activePanel={primaryPanel}
				onOpenPanel={togglePanel}
			/>

			<PrimaryPanelView
				panel={primaryPanel}
				workspace={initialWorkspace}
				activeChat={activeChat}
				theme={theme}
				onThemeChange={setTheme}
				onSelectChat={selectChat}
				onNewChat={onNewChat}
				onClose={() => setPrimaryPanel(null)}
				onImportLaunched={onImportLaunched}
				conversation={conversation}
				onConversationChange={setConversation}
				libraryFocusCharacterId={libraryFocusCharacterId}
				onLibraryFocusConsumed={() => setLibraryFocusCharacterId(null)}
				onOpenLibraryCharacter={(characterId) => {
					// "Save as Character" keeps the user in the Chat: the Cast
					// drawer announces the new Character and only navigates to
					// the Library entry when the user follows the offered action.
					setLibraryFocusCharacterId(characterId);
					setPrimaryPanel("library");
				}}
				mutationsDisabled={story.preview !== null}
			/>

			<main
				className="story-stage"
				aria-label="Active Chat"
				data-preview-mode={story.preview !== null}
			>
				<StoryHeader
					chat={activeChat}
					isGenerating={isGenerating}
					onOpenCast={() => togglePanel("cast")}
					onOpenInfo={() => {
						if (story.preview !== null) return;
						setChatInfoOpen(true);
						setPrimaryPanel(null);
					}}
				/>

				<div className="story-scroll" ref={storyScrollRef}>
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
									onClick={() => void loadMoreHistory()}
								>
									{story.status === "loading-more"
										? "Loading more Messages…"
										: "Load more Messages"}
								</button>
							</div>
						)}
						{story.messages.length === 0 && story.status !== "loading-first" && (
							<EmptyChat />
						)}
						{story.messages.map((message) =>
							isPreviewDownstream(message, story.preview) ? (
								<PreviewSkeleton key={message.id} messageId={message.id} />
							) : (
								<StoryMessageView
									key={message.id}
									message={message}
									displayedVariantId={
										story.preview?.messageId === message.id
											? displayedVariantId(message, story.preview)
											: undefined
									}
									mutationsDisabled={story.preview !== null}
									onMoveSwipe={(messageId, direction) =>
										void changeSwipe(messageId, direction)
									}
									onEdit={(messageId, content) =>
										void editStoryMessage(messageId, content)
									}
								/>
							)
						)}
						{story.status === "loading-first" && (
							<HistoryLoading />
						)}
						{story.status === "error" && (
							<p className="history-error" role="alert">
								The Chat history could not be loaded. Try opening the Chat
								again.
							</p>
						)}
						{isGenerating && (streamingOutput.content.length > 0 || streamingOutput.reasoning.length > 0
							? <StreamingGeneration content={streamingOutput.content} reasoning={streamingOutput.reasoning} />
							: <GenerationPlaceholder />)}
						<div className="latest-anchor" ref={latestRef} aria-hidden="true" />
					</div>
				</div>

				<Composer
					draft={draft}
					isGenerating={isGenerating}
					canWrite={conversation?.playable === true && !isGenerating && story.preview === null}
					isReceded={composerIsReceded}
					onDraftChange={setDraft}
					onFocusChange={setIsComposerFocused}
				onSubmit={submitMessage}
				onCancel={cancelGeneration}
					controlSelectors={
						conversation !== null ? (
							<ComposerControlSelectors
								conversation={conversation}
								disabled={story.preview !== null}
								onConversationChange={setConversation}
							/>
						) : null
					}
				/>
				{generationError !== null && <p className="generation-error" role="alert">{generationError}</p>}
			</main>

			{chatInfoOpen && story.preview === null && (
				<ChatInformationPanel
					conversationId={Number(activeChatId)}
					chatTitle={activeChat.title}
					onClose={() => setChatInfoOpen(false)}
				/>
			)}

			{newChatOpen && (
				<NewChatSurface
					onCreated={onNewChatCreated}
					onClose={onNewChatClose}
				/>
			)}

			{story.preview?.noticeOpen && (
				<PreviewNotice
					targetPosition={story.preview.targetPosition}
					pending={previewPending}
					error={previewError}
					onConfirm={() => void confirmPreview()}
					onCancel={cancelPreview}
					onClose={() => dispatchStory({ type: "preview-notice-closed" })}
				/>
			)}
		</div>
	);
}

