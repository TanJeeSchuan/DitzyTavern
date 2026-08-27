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
	stopAllConversationGenerations,
	stopConversationGeneration,
	streamConversationReply,
	subscribeConversationGeneration,
	streamConversationContinuation,
	loadConversation,
	type ConversationSummary,
} from "../conversation";
import {
	createStoryState,
	classifyVariantSelection,
	confirmPreviewSelection,
	deriveRevisionWindow,
	displayedVariantId,
	isModelAuthoredMessage,
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
	GenerationControls,
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
	const [stopPending, setStopPending] = useState(false);
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

	// A Conversation snapshot carries the server-owned provisional target. On
	// reload or after returning from another Chat, subscribe from event zero:
	// the server either replays the retained ordered stream or sends its
	// authoritative checkpoint before live events. No browser-local text is
	// needed to reconstruct the visible target.
	useEffect(() => {
		const active = conversation?.activeGeneration;
		const activeGenerations = conversation?.activeGenerations ??
			(active === undefined || active === null ? [] : [active]);
		if (activeGenerations.length === 0 || conversation === null) return;
		// The initiating POST already owns a subscriber. A second replay from
		// event zero would duplicate its deltas in the local presentation; a
		// later reload/navigation (with no active POST) attaches normally.
		if (generationAbortRef.current !== null) return;
		const controller = new AbortController();
		const conversationId = conversation.id;
		let current = true;
		setIsGenerating(true);
		const outputByGeneration = new Map<number, { content: string; reasoning: string }>();
		for (const target of activeGenerations) outputByGeneration.set(target.generationId, { content: "", reasoning: "" });
		const subscriptions = activeGenerations.map((target) => subscribeConversationGeneration(conversationId, target.generationId, {
			signal: controller.signal,
			onDelta: (event) => {
				if (!current || Number(activeChatIdRef.current) !== conversationId) return;
				const output = outputByGeneration.get(target.generationId) ?? { content: "", reasoning: "" };
				if (event.type === "content") output.content += event.text;
				if (event.type === "reasoning") output.reasoning += event.text;
				outputByGeneration.set(target.generationId, output);
				if (target.generationId === activeGenerations[0]?.generationId) setStreamingOutput(output);
				dispatchStory({ type: "generation-content", messageId: target.messageId, variantId: target.variantId, content: output.content });
			},
			onState: (state) => {
				if (!current || Number(activeChatIdRef.current) !== conversationId) return;
				outputByGeneration.set(target.generationId, { content: state.content, reasoning: state.reasoning });
				if (target.generationId === activeGenerations[0]?.generationId) setStreamingOutput({ content: state.content, reasoning: state.reasoning });
				dispatchStory({ type: "generation-content", messageId: target.messageId, variantId: target.variantId, content: state.content });
			},
		}));
		void Promise.all(subscriptions).then(async () => {
			if (!current) return;
			const [freshConversation, freshHistory] = await Promise.all([
				loadConversation(conversationId),
				chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
			]);
			if (!current || Number(activeChatIdRef.current) !== conversationId) return;
			if (freshConversation !== null) setConversation(freshConversation);
			if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
		}).finally(() => {
			if (!current || Number(activeChatIdRef.current) !== conversationId) return;
			setIsGenerating(false);
			setStreamingOutput({ content: "", reasoning: "" });
		});
		return () => {
			current = false;
			controller.abort();
		};
	}, [conversation?.activeGeneration?.generationId, conversation?.activeGenerations?.length, conversation?.id]);

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

	const activeGenerationTargets = conversation === null
		? []
		: conversation.activeGenerations ?? (conversation.activeGeneration === null || conversation.activeGeneration === undefined
			? []
			: [conversation.activeGeneration]);
	const selectedGenerationTarget = activeGenerationTargets.find((target) => {
		const message = story.messages.find((entry) => entry.id === target.messageId);
		return message?.swipes[message.activeSwipe]?.id === target.variantId;
	}) ?? activeGenerationTargets[0];

	const refreshAfterStop = async (conversationId: number) => {
		const [freshConversation, freshHistory] = await Promise.all([
			loadConversation(conversationId),
			chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
		]);
		if (Number(activeChatIdRef.current) !== conversationId) return;
		if (freshConversation !== null) setConversation(freshConversation);
		if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
	};

	const stopGeneration = async (generationId: number) => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || stopPending) return;
		setStopPending(true);
		setGenerationError(null);
		try {
			const outcome = await stopConversationGeneration(conversationId, generationId);
			// This abort only ends the initiating request's local subscription. The
			// explicit Stop command above owns provider cancellation on the server.
			generationAbortRef.current?.abort();
			generationAbortRef.current = null;
			setIsGenerating(false);
			setStreamingOutput({ content: "", reasoning: "" });
			await refreshAfterStop(conversationId);
			if (outcome.outcome === "failed") setGenerationError(outcome.reason);
		} catch {
			setGenerationError("Generation could not be stopped.");
		} finally {
			setStopPending(false);
		}
	};

	const stopAllGenerations = async () => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || activeGenerationTargets.length < 2 || stopPending) return;
		setStopPending(true);
		setGenerationError(null);
		try {
			const outcome = await stopAllConversationGenerations(conversationId);
			generationAbortRef.current?.abort();
			generationAbortRef.current = null;
			setIsGenerating(false);
			setStreamingOutput({ content: "", reasoning: "" });
			await refreshAfterStop(conversationId);
			if (outcome.outcome === "failed") setGenerationError(outcome.reason);
		} catch {
			setGenerationError("Generations could not be stopped.");
		} finally {
			setStopPending(false);
		}
	};

	const cancelGeneration = () => {
		const target = selectedGenerationTarget?.generationId;
		if (target !== undefined) void stopGeneration(target);
	};

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
		if (story.preview !== null || isGenerating || conversation === null || !conversation.playable || draft.trim() === "") return;
		const content = draft;
		const expectedRevision = conversation.revision;
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
			expectedRevision,
			content,
			signal: controller.signal,
			onAccepted: () => {
				if (!requestIsCurrent()) return;
				setDraft("");
				// The accepted human Message and provisional model position are
				// authoritative immediately, so history can show both while the
				// normalized provider stream is still in flight.
				void Promise.all([
					loadConversation(conversationId),
					chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
				]).then(([freshConversation, freshHistory]) => {
					if (!requestIsCurrent()) return;
					if (freshConversation !== null) setConversation(freshConversation);
					if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
				});
			},
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
				if (outcome.outcome === "stopped") return;
				// A Send acceptance and its terminal cleanup/resolution each
				// advance the authoritative Conversation revision. Refresh both
				// reads after any terminal rejection so a retry can reuse an
				// unanswered human Message with the current revision.
				const [freshConversation, freshHistory] = await Promise.all([
					loadConversation(conversationId),
					chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
				]);
				if (!requestIsCurrent()) return;
				if (freshConversation !== null) setConversation(freshConversation);
				if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
				setGenerationError(outcome.reason);
			})
			.catch(async () => {
				if (!requestIsCurrent()) return;
				if (controller.signal.aborted) {
					// The server preserves any received partial output as an interrupted
					// Variant before the cancelled request unwinds. Refresh the visible
					// history so cancellation does not discard that writing in the UI.
					const [freshConversation, freshHistory] = await Promise.all([
						loadConversation(conversationId),
						chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
					]);
					if (!requestIsCurrent()) return;
					if (freshConversation !== null) setConversation(freshConversation);
					if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
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

	const continueMessage = (messageId: number) => {
		if (story.preview !== null || isGenerating || conversation === null || !conversation.playable) return;
		const latest = story.messages.at(-1);
		if (
			latest?.id !== messageId ||
			latest.continuable !== true ||
			!isModelAuthoredMessage(latest, conversation.control.modelParticipantId)
		) return;
		const expectedRevision = conversation.revision;
		setIsGenerating(true);
		setStreamingOutput({ content: "", reasoning: "" });
		setGenerationError(null);
		const controller = new AbortController();
		generationAbortRef.current = controller;
		const conversationId = conversation.id;
		const requestIsCurrent = () =>
			generationAbortRef.current === controller &&
			Number(activeChatIdRef.current) === conversationId;
		void streamConversationContinuation(conversationId, {
			expectedRevision,
			signal: controller.signal,
			onAccepted: () => {
				if (!requestIsCurrent()) return;
				// The server-owned acceptance is authoritative before provider
				// deltas arrive. Refresh so the provisional model Message and
				// Active Generation target are visible during the stream.
				void Promise.all([
					loadConversation(conversationId),
					chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
				]).then(([freshConversation, freshHistory]) => {
					if (!requestIsCurrent()) return;
					if (freshConversation !== null) setConversation(freshConversation);
					if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
				});
			},
			onDelta: (event) => {
				if (!requestIsCurrent()) return;
				if (event.type === "content") setStreamingOutput((current) => ({ ...current, content: current.content + event.text }));
				if (event.type === "reasoning") setStreamingOutput((current) => ({ ...current, reasoning: current.reasoning + event.text }));
			},
		})
			.then(async (outcome) => {
				if (!requestIsCurrent()) return;
				const [freshConversation, freshHistory] = await Promise.all([
					loadConversation(conversationId),
					chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
				]);
				if (!requestIsCurrent()) return;
				if (freshConversation !== null) setConversation(freshConversation);
				if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
				if (outcome.outcome !== "applied" && outcome.outcome !== "not-found" && outcome.outcome !== "stopped") {
					setGenerationError(outcome.reason);
				}
				if (outcome.outcome === "not-found") setGenerationError("The Conversation no longer exists.");
			})
			.catch(async () => {
				if (!requestIsCurrent()) return;
				const [freshConversation, freshHistory] = await Promise.all([
					loadConversation(conversationId),
					chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
				]);
				if (!requestIsCurrent()) return;
				if (freshConversation !== null) setConversation(freshConversation);
				if (freshHistory.status === "available") dispatchStory({ type: "first-page", page: freshHistory.page });
				setGenerationError("Generation could not be completed.");
			})
			.finally(() => {
				if (!requestIsCurrent()) return;
				generationAbortRef.current = null;
				setIsGenerating(false);
				setStreamingOutput({ content: "", reasoning: "" });
			});
	};

	const latestStoryMessage = story.messages.at(-1);
	const modelParticipant = conversation === null
		? null
		: conversation.cast.find((participant) => participant.id === conversation.control.modelParticipantId) ?? null;
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
									canContinue={
										latestStoryMessage?.id === message.id &&
										conversation?.playable === true &&
										(conversation.activeGenerations?.length ?? (conversation.activeGeneration === null ? 0 : 1)) === 0 &&
										isModelAuthoredMessage(message, conversation.control.modelParticipantId) &&
										message.continuable === true &&
										isGenerating === false &&
										story.preview === null
									}
									continueLabel={modelParticipant === null ? "Continue" : `Continue as ${modelParticipant.name}`}
									onContinue={continueMessage}
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
						{isGenerating && activeGenerationTargets.length > 0 && (
							<GenerationControls
								showStopAll={activeGenerationTargets.length > 1}
								pending={stopPending}
								onStop={() => void stopGeneration(selectedGenerationTarget!.generationId)}
								onStopAll={() => void stopAllGenerations()}
							/>
						)}
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
				stopPending={stopPending}
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
					conversation={conversation}
					onConversationChange={setConversation}
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
