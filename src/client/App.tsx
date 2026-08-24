import {
	BookOpen,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Edit3,
	Info,
	MessageSquare,
	Monitor,
	Moon,
	Plus,
	Send,
	Settings,
	Sun,
	Users,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
} from "react";
import { CharacterLibraryPanel } from "./CharacterLibraryPanel";
import { CastPanel } from "./CastPanel";
import { ChatInformationPanel } from "./ChatInformationPanel";
import { ComposerControlSelectors } from "./ComposerControls";
import { ImportChatHost } from "./ImportChatHost";
import { NewChatPanel } from "./NewChatPanel";
import { PanelHeader } from "./PanelHeader";
import { chatHistoryTransport } from "./chat-history";
import {
	createStoryState,
	moveActiveSwipe,
	reduceStory,
	visibleVariantContent,
	type StoryMessage,
} from "./story";
import {
	applyConversationCommand,
	loadConversation,
	type ConversationSnapshot,
} from "./conversation";
import {
	type ChatSummary,
	type ThemePreference,
	type Workspace,
	workspaceClient,
} from "./workspace";

type WorkspaceState =
	| { status: "loading" }
	| { status: "ready"; workspace: Workspace }
	| { status: "error" };

type PrimaryPanel = "chats" | "cast" | "library" | "settings" | null;

export function App() {
	const [state, setState] = useState<WorkspaceState>({ status: "loading" });
	// A just-imported Chat to open after the workspace reloads. It lives at
	// App level because reloading the workspace unmounts the whole tree, and
	// the selection must survive until the reloaded chat list contains it.
	const [importLaunchChatId, setImportLaunchChatId] = useState<string | null>(null);

	const loadWorkspace = useCallback(async () => {
		setState({ status: "loading" });
		try {
			const workspace = await workspaceClient.loadActiveWorkspace();
			setState({ status: "ready", workspace });
		} catch {
			setState({ status: "error" });
		}
	}, []);

	const handleImportLaunched = useCallback(
		async (conversationId: number) => {
			setImportLaunchChatId(String(conversationId));
			try {
				await loadWorkspace();
			} finally {
				// Clears after the reloaded workspace rendered, so the selection
				// effect could observe the target in the refreshed chat list.
				window.setTimeout(() => setImportLaunchChatId(null), 0);
			}
		},
		[loadWorkspace],
	);

	useEffect(() => {
		void loadWorkspace();
	}, [loadWorkspace]);

	if (state.status === "loading") {
		return <WorkspaceLoading />;
	}

	if (state.status === "error") {
		return <WorkspaceError onRetry={() => void loadWorkspace()} />;
	}

	return (
		<WritingWorkspace
			initialWorkspace={state.workspace}
			onReload={loadWorkspace}
			importLaunchChatId={importLaunchChatId}
			onImportLaunched={(conversationId) =>
				void handleImportLaunched(conversationId)
			}
		/>
	);
}

function WritingWorkspace({
	initialWorkspace,
	onReload,
	importLaunchChatId,
	onImportLaunched,
}: {
	initialWorkspace: Workspace;
	onReload: () => Promise<void>;
	importLaunchChatId: string | null;
	onImportLaunched: (conversationId: number) => void;
}) {
	const [newChatOpen, setNewChatOpen] = useState(false);

	const handleCreated = async () => {
		setNewChatOpen(false);
		await onReload();
	};

	if (!initialWorkspace.activeChat) {
		return (
			<>
				<WorkspaceWithoutChats onNewChat={() => setNewChatOpen(true)} />
				{newChatOpen && (
					<NewChatSurface
						onCreated={() => void handleCreated()}
						onClose={() => setNewChatOpen(false)}
					/>
				)}
			</>
		);
	}

	return (
		<>
			<ActiveWritingWorkspace
				key={initialWorkspace.activeChat.id}
				initialWorkspace={{
					...initialWorkspace,
					activeChat: initialWorkspace.activeChat,
				}}
				onNewChat={() => setNewChatOpen(true)}
				newChatOpen={newChatOpen}
				onNewChatClose={() => setNewChatOpen(false)}
				onNewChatCreated={() => void handleCreated()}
				importLaunchChatId={importLaunchChatId}
				onImportLaunched={onImportLaunched}
			/>
		</>
	);
}

function NewChatSurface({
	onCreated,
	onClose,
}: {
	onCreated: (conversationId: number) => void;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel" data-open="true">
			<PanelHeader title="New Chat" onClose={onClose} />
			<NewChatPanel onCreated={onCreated} />
		</aside>
	);
}

function ActiveWritingWorkspace({
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
	const [conversation, setConversation] = useState<ConversationSnapshot | null>(
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
	const isGenerating = false;
	const activeChat =
		initialWorkspace.chats.find((chat) => chat.id === activeChatId) ??
		initialWorkspace.activeChat;

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
		loadConversation(conversationId)
			.then(setConversation)
			.catch(() => setConversation(null));
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
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const target = storyMessage.swipes[moveActiveSwipe(storyMessage, direction)];
		if (target === undefined) return;
		dispatchStory({
			type: "swipe-selected",
			messageId,
			variantId: target.id,
		});
		const conversationId = story.conversationId;
		if (conversationId === null) return;
		const expectedRevision = conversation?.revision ?? story.revision ?? -1;
		if (expectedRevision < 0) return;
		const outcome = await applyConversationCommand(conversationId, expectedRevision, {
			type: "select-variant",
			messageId,
			variantId: target.id,
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

	const submitMessage = (event: FormEvent) => {
		event.preventDefault();
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
			/>

			<main className="story-stage" aria-label="Active Chat">
				<StoryHeader
					chat={activeChat}
					isGenerating={isGenerating}
					onOpenCast={() => togglePanel("cast")}
					onOpenInfo={() => {
						setChatInfoOpen(true);
						setPrimaryPanel(null);
					}}
				/>

				<div className="story-scroll" ref={storyScrollRef}>
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
						{story.messages.map((message) => (
							<StoryMessageView
								key={message.id}
								message={message}
								onMoveSwipe={(messageId, direction) =>
									void changeSwipe(messageId, direction)
							}
							onEdit={(messageId, content) =>
								void editStoryMessage(messageId, content)
							}
						/>
						))}
						{story.status === "loading-first" && (
							<HistoryLoading />
						)}
						{story.status === "error" && (
							<p className="history-error" role="alert">
								The Chat history could not be loaded. Try opening the Chat
								again.
							</p>
						)}
						{isGenerating && <GenerationPlaceholder />}
						<div className="latest-anchor" ref={latestRef} aria-hidden="true" />
					</div>
				</div>

				<Composer
					draft={draft}
					isGenerating={isGenerating}
					canWrite={false}
					isReceded={composerIsReceded}
					onDraftChange={setDraft}
					onFocusChange={setIsComposerFocused}
					onSubmit={submitMessage}
					controlSelectors={
						conversation !== null ? (
							<ComposerControlSelectors
								conversation={conversation}
								onConversationChange={setConversation}
							/>
						) : null
					}
				/>
			</main>

			{chatInfoOpen && (
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
		</div>
	);
}

function NavigationRail({
	activePanel,
	onOpenPanel,
}: {
	activePanel: PrimaryPanel;
	onOpenPanel: (panel: Exclude<PrimaryPanel, null>) => void;
}) {
	return (
		<nav className="navigation-rail" aria-label="Workspace">
			<div className="brand-mark" aria-label="DitzyTavern">
				DT
			</div>
			<div className="rail-actions">
				<RailButton
					label="Chats"
					active={activePanel === "chats"}
					onClick={() => onOpenPanel("chats")}
				>
					<MessageSquare aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Cast"
					active={activePanel === "cast"}
					onClick={() => onOpenPanel("cast")}
				>
					<Users aria-hidden="true" />
				</RailButton>
			<RailButton
				label="Library"
				active={activePanel === "library"}
				onClick={() => onOpenPanel("library")}
			>
				<BookOpen aria-hidden="true" />
			</RailButton>
			</div>
			<RailButton
				label="Settings"
				active={activePanel === "settings"}
				onClick={() => onOpenPanel("settings")}
			>
				<Settings aria-hidden="true" />
			</RailButton>
		</nav>
	);
}

function RailButton({
	label,
	active = false,
	disabled = false,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick?: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className="rail-button"
			aria-label={label}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
			<span className="rail-label">{disabled ? `${label} unavailable` : label}</span>
		</button>
	);
}

function PrimaryPanelView({
	panel,
	workspace,
	activeChat,
	theme,
	onThemeChange,
	onSelectChat,
	onNewChat,
	onClose,
	onImportLaunched,
	conversation,
	onConversationChange,
	libraryFocusCharacterId,
	onLibraryFocusConsumed,
	onOpenLibraryCharacter,
}: {
	panel: PrimaryPanel;
	workspace: Workspace;
	activeChat: ChatSummary;
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
	onSelectChat: (chatId: string) => void;
	onNewChat: () => void;
	onClose: () => void;
	onImportLaunched: (conversationId: number) => void;
	conversation: ConversationSnapshot | null;
	onConversationChange: (conversation: ConversationSnapshot | null) => void;
	libraryFocusCharacterId: number | null;
	onLibraryFocusConsumed: () => void;
	onOpenLibraryCharacter: (characterId: number) => void;
}) {
	return (
		<aside className="primary-panel" data-open={Boolean(panel)} aria-hidden={!panel}>
			{/* The Chats host stays mounted across panel toggles so the staged
			    import flow survives; every other panel renders its own header. */}
			<ImportChatHost
				open={panel === "chats"}
				chats={workspace.chats}
				activeId={activeChat.id}
				characters={workspace.characters}
				onSelect={onSelectChat}
				onNewChat={onNewChat}
				onClose={onClose}
				onImportLaunched={onImportLaunched}
			/>
			{panel !== null && panel !== "chats" && (
				<>
					<PanelHeader
						title={
							panel === "cast"
								? "Cast"
								: panel === "library"
									? "Character Library"
									: "Settings"
						}
						onClose={onClose}
					/>
					{panel === "cast" && (
						<CastPanel
							conversationId={Number(activeChat.id)}
							conversation={conversation}
							onConversationChange={onConversationChange}
							onOpenLibraryCharacter={onOpenLibraryCharacter}
						/>
					)}
					{panel === "library" && (
						<CharacterLibraryPanel
							focusCharacterId={libraryFocusCharacterId}
							onFocusConsumed={onLibraryFocusConsumed}
						/>
					)}
					{panel === "settings" && (
						<SettingsPanel theme={theme} onThemeChange={onThemeChange} />
					)}
				</>
			)}
		</aside>
	);
}

function SettingsPanel({
	theme,
	onThemeChange,
}: {
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
}) {
	const choices: Array<{
		value: ThemePreference;
		label: string;
		icon: React.ReactNode;
	}> = [
		{ value: "system", label: "System", icon: <Monitor aria-hidden="true" /> },
		{ value: "daylight", label: "Daylight", icon: <Sun aria-hidden="true" /> },
		{ value: "evening", label: "Evening", icon: <Moon aria-hidden="true" /> },
	];

	return (
		<div className="panel-body settings-panel-body">
			<section>
				<h3>Appearance</h3>
				<p>Choose how the writing room responds to your display.</p>
				<div className="theme-options">
					{choices.map((choice) => (
						<button
							type="button"
							key={choice.value}
							data-active={theme === choice.value}
							onClick={() => onThemeChange(choice.value)}
						>
							{choice.icon}
							<span>{choice.label}</span>
							{theme === choice.value && <Check aria-hidden="true" />}
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

function StoryHeader({
	chat,
	isGenerating,
	onOpenCast,
	onOpenInfo,
}: {
	chat: ChatSummary;
	isGenerating: boolean;
	onOpenCast: () => void;
	onOpenInfo: () => void;
}) {
	return (
		<header className="story-header">
			<div className="story-title">
				<span>Active Chat</span>
				<h1>{chat.title}</h1>
			</div>
			{isGenerating && (
				<div className="generation-state" role="status">
					<span aria-hidden="true" />
					Writing
				</div>
			)}
			<button
				className="icon-button chat-info-button"
				type="button"
				onClick={onOpenInfo}
				aria-label="Chat information"
			>
				<Info aria-hidden="true" />
			</button>
			<button className="cast-control" type="button" onClick={onOpenCast}>
				<span>Cast</span>
				<ChevronDown aria-hidden="true" />
			</button>
		</header>
	);
}

function EmptyChat() {
	return (
		<section className="empty-chat">
			<h2>This Chat has no stored Messages yet</h2>
			<p>
				Native Chats begin with the model Participant's openings as their
				first Message. History appears here as Messages are added.
			</p>
		</section>
	);
}

function HistoryLoading() {
	return (
		<div className="generation-placeholder" role="status" aria-live="polite">
			<div className="placeholder-header">
				<span className="skeleton portrait-skeleton" />
				<span className="skeleton label-skeleton" />
			</div>
			<div className="skeleton prose-skeleton wide" />
			<div className="skeleton prose-skeleton" />
			<span className="sr-only">Loading history</span>
		</div>
	);
}

const formatTimestamp = (value: string): string => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
};

// The story renders one native Message from the paginated read model: the
// immutable Author Stamp name, the persisted selected Variant, and the
// existing Swipe navigation. Empty and duplicate Variants stay separate
// positions; an exact empty Variant renders a presentation-only placeholder
// and its stored text is never modified.
function StoryMessageView({
	message,
	onMoveSwipe,
	onEdit,
}: {
	message: StoryMessage;
	onMoveSwipe: (messageId: number, direction: -1 | 1) => void;
	onEdit: (messageId: number, content: string) => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const active = message.swipes[message.activeSwipe];
	const [editText, setEditText] = useState("");
	const authorName = message.authorName ?? "Unknown author";

	useEffect(() => {
		if (active !== undefined) {
			setEditText(active.content);
			setIsEditing(false);
		}
	}, [active?.id, active?.content]);

	const saveEdit = () => {
		const value = editText.trim();
		if (!value || active === undefined) return;
		onEdit(message.id, value);
		setIsEditing(false);
	};

	return (
		<article
			className="story-message"
			data-message-id={message.id}
			data-author-in-cast={message.inCast}
		>
			<header className="message-header">
				<Portrait name={authorName} size="medium" />
				<div className="message-author">
					<strong>{authorName}</strong>
					<div className="message-meta">
						<time>{formatTimestamp(message.timestamp)}</time>
						{!message.inCast && <span className="not-in-cast">not in Cast</span>}
					</div>
				</div>
			</header>

			{isEditing && active !== undefined ? (
				<div className="message-editor">
					<label htmlFor={`edit-${message.id}`}>Edit Message</label>
					<textarea
						id={`edit-${message.id}`}
						value={editText}
						onChange={(event) => setEditText(event.target.value)}
						autoFocus
					/>
					<div>
						<button
							className="secondary-button"
							type="button"
							onClick={() => setIsEditing(false)}
						>
							Cancel
						</button>
						<button
							className="primary-button"
							type="button"
							onClick={saveEdit}
						>
							Save
						</button>
					</div>
				</div>
			) : (
				<div
					className="prose"
					data-empty-variant={active?.empty === true}
				>
					{active !== undefined
						? visibleVariantContent(active)
								.split("\n\n")
								.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
						: null}
				</div>
			)}

			<footer className="message-actions">
				<button
					className="edit-action"
					type="button"
					onClick={() => setIsEditing(true)}
				>
					<Edit3 aria-hidden="true" /> Edit
				</button>
				<div className="swipe-controls" aria-label="Swipe controls">
					<button
						className="icon-button"
						type="button"
						onClick={() => onMoveSwipe(message.id, -1)}
						disabled={message.activeSwipe === 0}
						aria-label="Previous Swipe"
					>
						<ChevronLeft aria-hidden="true" />
					</button>
					<span>
						{message.activeSwipe + 1} of {message.swipes.length}
					</span>
					<button
						className="icon-button"
						type="button"
						onClick={() => onMoveSwipe(message.id, 1)}
						disabled={message.activeSwipe === message.swipes.length - 1}
						aria-label="Next Swipe"
					>
						<ChevronRight aria-hidden="true" />
					</button>
				</div>
			</footer>
		</article>
	);
}

function Composer({
	draft,
	isGenerating,
	canWrite,
	isReceded,
	controlSelectors,
	onDraftChange,
	onFocusChange,
	onSubmit,
}: {
	draft: string;
	isGenerating: boolean;
	canWrite: boolean;
	isReceded: boolean;
	controlSelectors?: React.ReactNode;
	onDraftChange: (value: string) => void;
	onFocusChange: (focused: boolean) => void;
	onSubmit: (event: FormEvent) => void;
}) {
	return (
		<form
			className="composer"
			data-disabled={!canWrite}
			data-receded={isReceded}
			onSubmit={onSubmit}
			onFocus={() => onFocusChange(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					onFocusChange(false);
				}
			}}
		>
			{controlSelectors !== undefined && (
				<div className="composer-controls-row">{controlSelectors}</div>
			)}
			<label htmlFor="writer-message" className="sr-only">
				Message draft
			</label>
			<textarea
				id="writer-message"
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
				placeholder="Message storage is not available yet"
				disabled={!canWrite}
				rows={1}
			/>
			<button className="send-button" type="submit" disabled={!canWrite || !draft.trim() || isGenerating} aria-label="Send Message">
				<Send aria-hidden="true" />
			</button>
		</form>
	);
}

function Portrait({ name, size }: { name?: string; size: "small" | "medium" | "large" }) {
	const initial = name?.trim().charAt(0).toLocaleUpperCase() ?? "?";
	return (
		<span className="portrait" data-size={size} aria-hidden="true">
			<span>{initial}</span>
		</span>
	);
}

function GenerationPlaceholder() {
	return (
		<div className="generation-placeholder" role="status" aria-live="polite">
			<div className="placeholder-header">
				<span className="skeleton portrait-skeleton" />
				<span className="skeleton label-skeleton" />
			</div>
			<div className="skeleton prose-skeleton wide" />
			<div className="skeleton prose-skeleton" />
			<span className="sr-only">Generating Message</span>
		</div>
	);
}

function WorkspaceLoading() {
	return (
		<main className="workspace-loading" aria-busy="true" aria-live="polite">
			<span className="sr-only">Loading workspace</span>
			<div className="loading-rail" />
			<section className="loading-stage">
				<div className="loading-header" />
				<div className="loading-copy">
					<div className="skeleton label-skeleton" />
					<div className="skeleton prose-skeleton wide" />
					<div className="skeleton prose-skeleton" />
				</div>
			</section>
		</main>
	);
}

function WorkspaceError({ onRetry }: { onRetry: () => void }) {
	return (
		<main className="workspace-error">
			<div>
				<BookOpen aria-hidden="true" />
				<h1>The Chat could not be opened</h1>
				<p>Your story is still safe. Try loading the workspace again.</p>
				<button className="primary-button" type="button" onClick={onRetry}>Try again</button>
			</div>
		</main>
	);
}

function WorkspaceWithoutChats({ onNewChat }: { onNewChat: () => void }) {
	return (
		<main className="workspace-error">
			<div>
				<MessageSquare aria-hidden="true" />
				<h1>No Chats found</h1>
				<p>Create a native Chat with two Participants to open the writing workspace.</p>
				<button className="primary-button" type="button" onClick={onNewChat}>
					<Plus aria-hidden="true" /> New Chat
				</button>
			</div>
		</main>
	);
}