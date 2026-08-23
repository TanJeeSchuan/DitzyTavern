import {
	BookOpen,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Copy,
	Edit3,
	Info,
	MessageSquare,
	Monitor,
	Moon,
	MoreHorizontal,
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
	useRef,
	useState,
} from "react";
import { CharacterLibraryPanel } from "./CharacterLibraryPanel";
import { CastPanel } from "./CastPanel";
import { ComposerControlSelectors } from "./ComposerControls";
import { ImportChatHost } from "./ImportChatHost";
import { NewChatPanel } from "./NewChatPanel";
import { PanelHeader } from "./PanelHeader";
import {
	loadConversation,
	type ConversationSnapshot,
} from "./conversation";
import {
	type ChatSummary,
	type GeneratedMessage,
	type StoryMessage,
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
	const [messages, setMessages] = useState(initialWorkspace.messages);
	const [activeChatId, setActiveChatId] = useState(initialWorkspace.activeChat.id);
	const [primaryPanel, setPrimaryPanel] = useState<PrimaryPanel>(null);
	const [conversation, setConversation] = useState<ConversationSnapshot | null>(
		null,
	);
	const [detailMessageId, setDetailMessageId] = useState<string | null>(null);
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
	const isGenerating = false;
	const activeChat =
		initialWorkspace.chats.find((chat) => chat.id === activeChatId) ??
		initialWorkspace.activeChat;
	const detailMessage = messages.find(
		(message): message is GeneratedMessage =>
			message.id === detailMessageId && message.type === "generated",
	);

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
	}, [messages.length, isGenerating]);

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
		setDetailMessageId(null);
		setPrimaryPanel((current) => (current === panel ? null : panel));
	};

	const showMessageDetails = (messageId: string) => {
		setPrimaryPanel(null);
		setDetailMessageId(messageId);
	};

	const selectChat = (chatId: string) => {
		setActiveChatId(chatId);
		setMessages([]);
		setDetailMessageId(null);
		setPrimaryPanel(null);
	};

	const updateMessage = (messageId: string, text: string) => {
		setMessages((current) =>
			current.map((message) => {
				if (message.id !== messageId || message.type !== "generated") {
					return message;
				}
				return {
					...message,
					swipes: message.swipes.map((swipe, index) =>
						index === message.activeSwipe ? { ...swipe, text } : swipe,
					),
				};
			}),
		);
	};

	const moveSwipe = (messageId: string, direction: -1 | 1) => {
		setMessages((current) =>
			current.map((message) => {
				if (message.id !== messageId || message.type !== "generated") {
					return message;
				}
				const next = Math.min(
					message.swipes.length - 1,
					Math.max(0, message.activeSwipe + direction),
				);
				return { ...message, activeSwipe: next };
			}),
		);
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
				/>

				<div className="story-scroll" ref={storyScrollRef}>
					<div className="story-content">
						{messages.length === 0 && <EmptyChat />}
						{messages.map((message) => (
							<StoryMessageView
								key={message.id}
								message={message}
								authorName={message.authorId}
								onMoveSwipe={moveSwipe}
								onShowDetails={showMessageDetails}
								onUpdate={updateMessage}
							/>
						))}
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

			<MessageDetailsPanel
				message={detailMessage}
				authorName={detailMessage?.authorId}
				onClose={() => setDetailMessageId(null)}
			/>

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
}: {
	chat: ChatSummary;
	isGenerating: boolean;
	onOpenCast: () => void;
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
				Native Chats begin with the model Participant's openings as their first
				Message. Writing will become available when Message storage is added.
			</p>
		</section>
	);
}

function StoryMessageView({
	message,
	authorName,
	onMoveSwipe,
	onShowDetails,
	onUpdate,
}: {
	message: StoryMessage;
	authorName?: string;
	onMoveSwipe: (messageId: string, direction: -1 | 1) => void;
	onShowDetails: (messageId: string) => void;
	onUpdate: (messageId: string, text: string) => void;
}) {
	if (message.type === "writer") {
		return (
			<article className="writer-message">
				<header>
					<span>{authorName ?? "Unknown author"}</span>
					<time>{message.createdAt}</time>
				</header>
				<p>{message.text}</p>
			</article>
		);
	}

	return (
		<GeneratedStoryMessage
			message={message}
			authorName={authorName}
			onMoveSwipe={onMoveSwipe}
			onShowDetails={onShowDetails}
			onUpdate={onUpdate}
		/>
	);
}

function GeneratedStoryMessage({
	message,
	authorName,
	onMoveSwipe,
	onShowDetails,
	onUpdate,
}: {
	message: GeneratedMessage;
	authorName?: string;
	onMoveSwipe: (messageId: string, direction: -1 | 1) => void;
	onShowDetails: (messageId: string) => void;
	onUpdate: (messageId: string, text: string) => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [isSelected, setIsSelected] = useState(false);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const activeSwipe = message.swipes[message.activeSwipe];
	const [editText, setEditText] = useState(activeSwipe.text);

	useEffect(() => {
		setEditText(activeSwipe.text);
		setIsEditing(false);
	}, [activeSwipe.id, activeSwipe.text]);

	const copyMessage = async () => {
		await navigator.clipboard.writeText(activeSwipe.text);
		setCopied(true);
		setIsMenuOpen(false);
		window.setTimeout(() => setCopied(false), 1600);
	};

	const saveEdit = () => {
		const value = editText.trim();
		if (!value) {
			return;
		}
		onUpdate(message.id, value);
		setIsEditing(false);
	};

	return (
		<article
			className="generated-message"
			data-selected={isSelected}
			onClick={(event) => {
				if (
					!(event.target instanceof Element) ||
					!event.target.closest("button, textarea")
				) {
					setIsSelected((current) => !current);
				}
			}}
		>
			<header className="message-header">
				<Portrait name={authorName} size="medium" />
				<div className="message-author">
					<strong>{authorName ?? "Unknown author"}</strong>
					<div className="message-meta">
						<span>{message.generation.profile}</span>
						<time>{message.createdAt}</time>
					</div>
				</div>
				<div className="advanced-actions">
					<button className="icon-button" type="button" onClick={() => onShowDetails(message.id)} aria-label={`Details for ${authorName ?? "Message"}`}>
						<Info aria-hidden="true" />
					</button>
					<div className="more-menu-wrap">
						<button className="icon-button" type="button" onClick={() => setIsMenuOpen((current) => !current)} aria-label="More Message actions" aria-expanded={isMenuOpen}>
							<MoreHorizontal aria-hidden="true" />
						</button>
						{isMenuOpen && (
							<div className="message-menu">
								<button type="button" onClick={() => void copyMessage()}>
									<Copy aria-hidden="true" /> Copy Message
								</button>
								<button type="button" onClick={() => onShowDetails(message.id)}>
									<Info aria-hidden="true" /> Inspect Prompt
								</button>
							</div>
						)}
					</div>
				</div>
			</header>

			{isEditing ? (
				<div className="message-editor">
					<label htmlFor={`edit-${message.id}`}>Edit Message</label>
					<textarea id={`edit-${message.id}`} value={editText} onChange={(event) => setEditText(event.target.value)} autoFocus />
					<div>
						<button className="secondary-button" type="button" onClick={() => setIsEditing(false)}>Cancel</button>
						<button className="primary-button" type="button" onClick={saveEdit}>Save</button>
					</div>
				</div>
			) : (
				<div className="prose">
					{activeSwipe.text.split("\n\n").map((paragraph) => (
						<p key={paragraph}>{paragraph}</p>
					))}
				</div>
			)}

			<footer className="message-actions">
				<button className="edit-action" type="button" onClick={() => setIsEditing(true)}>
					<Edit3 aria-hidden="true" /> Edit
				</button>
				<div className="swipe-controls" aria-label="Swipe controls">
					<button className="icon-button" type="button" onClick={() => onMoveSwipe(message.id, -1)} disabled={message.activeSwipe === 0} aria-label="Previous Swipe">
						<ChevronLeft aria-hidden="true" />
					</button>
					<span>{message.activeSwipe + 1} of {message.swipes.length}</span>
					<button className="icon-button" type="button" onClick={() => onMoveSwipe(message.id, 1)} disabled={message.activeSwipe === message.swipes.length - 1} aria-label="Next Swipe">
						<ChevronRight aria-hidden="true" />
					</button>
				</div>
				{copied && <span className="copy-confirmation" role="status"><Check aria-hidden="true" /> Copied</span>}
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

function MessageDetailsPanel({
	message,
	authorName,
	onClose,
}: {
	message?: GeneratedMessage;
	authorName?: string;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel" data-open={Boolean(message)} aria-hidden={!message}>
			{message && (
				<>
					<PanelHeader title="Message details" onClose={onClose} />
					<div className="panel-body details-body">
						<section className="author-detail">
							<Portrait name={authorName} size="large" />
							<div>
								<span>Author</span>
								<strong>{authorName ?? "Unknown author"}</strong>
							</div>
						</section>
						<dl className="detail-list">
							<div><dt>Generation profile</dt><dd>{message.generation.profile}</dd></div>
							<div><dt>Model</dt><dd>{message.generation.model}</dd></div>
							<div><dt>Created</dt><dd>{message.createdAt}</dd></div>
							<div><dt>Swipe</dt><dd>{message.activeSwipe + 1} of {message.swipes.length}</dd></div>
						</dl>
						<section className="prompt-inspection">
							<h3>Prompt</h3>
							<p>{message.generation.prompt}</p>
						</section>
						<p className="panel-note">Full provenance will connect here when Message inspection RPCs are available.</p>
					</div>
				</>
			)}
		</aside>
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