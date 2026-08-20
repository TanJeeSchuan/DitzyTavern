import {
	ArrowLeft,
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
	PanelLeftClose,
	Search,
	Send,
	Settings,
	Sun,
	Users,
} from "lucide-react";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ChatSummary,
	type GeneratedMessage,
	type Identity,
	type StoryMessage,
	type ThemePreference,
	type Workspace,
	workspaceClient,
} from "./workspace";

type WorkspaceState =
	| { status: "loading" }
	| { status: "ready"; workspace: Workspace }
	| { status: "error" };

type PrimaryPanel = "chats" | "cast" | "settings" | null;

export function App() {
	const [state, setState] = useState<WorkspaceState>({ status: "loading" });

	const loadWorkspace = useCallback(async () => {
		setState({ status: "loading" });
		try {
			const workspace = await workspaceClient.loadActiveWorkspace();
			setState({ status: "ready", workspace });
		} catch {
			setState({ status: "error" });
		}
	}, []);

	useEffect(() => {
		void loadWorkspace();
	}, [loadWorkspace]);

	if (state.status === "loading") {
		return <WorkspaceLoading />;
	}

	if (state.status === "error") {
		return <WorkspaceError onRetry={() => void loadWorkspace()} />;
	}

	return <WritingWorkspace initialWorkspace={state.workspace} />;
}

function WritingWorkspace({ initialWorkspace }: { initialWorkspace: Workspace }) {
	if (!initialWorkspace.activeChat) {
		return <WorkspaceWithoutChats />;
	}

	return (
		<ActiveWritingWorkspace
			initialWorkspace={{
				...initialWorkspace,
				activeChat: initialWorkspace.activeChat,
			}}
		/>
	);
}

function ActiveWritingWorkspace({
	initialWorkspace,
}: {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
}) {
	const [messages, setMessages] = useState(initialWorkspace.messages);
	const [activeChatId, setActiveChatId] = useState(initialWorkspace.activeChat.id);
	const [primaryPanel, setPrimaryPanel] = useState<PrimaryPanel>(null);
	const [detailMessageId, setDetailMessageId] = useState<string | null>(null);
	const [identityId, setIdentityId] = useState("writer");
	const [theme, setTheme] = useState<ThemePreference>("system");
	const [draft, setDraft] = useState("");
	const [isComposerFocused, setIsComposerFocused] = useState(false);
	const [isAtLatest, setIsAtLatest] = useState(true);
	const storyScrollRef = useRef<HTMLDivElement>(null);
	const latestRef = useRef<HTMLDivElement>(null);
	const isGenerating = false;
	const activeChat =
		initialWorkspace.chats.find((chat) => chat.id === activeChatId) ??
		initialWorkspace.activeChat;
	const activeCast = initialWorkspace.identities.filter((identity) =>
		activeChat.castIds.includes(identity.id),
	);

	const identitiesById = useMemo(
		() =>
			new Map(
				initialWorkspace.identities.map((identity) => [identity.id, identity]),
			),
		[initialWorkspace.identities],
	);
	const currentIdentity = identitiesById.get(identityId) ?? initialWorkspace.identities[0];
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
		<div className="workspace" data-ambience={currentIdentity.ambience}>
			<div className="ambient-field" aria-hidden="true" />
			<NavigationRail
				activePanel={primaryPanel}
				onOpenPanel={togglePanel}
			/>

			<PrimaryPanelView
				panel={primaryPanel}
				workspace={initialWorkspace}
				activeChat={activeChat}
				activeCast={activeCast}
				theme={theme}
				onThemeChange={setTheme}
				onSelectChat={selectChat}
				onClose={() => setPrimaryPanel(null)}
			/>

			<main className="story-stage" aria-label="Active Chat">
				<StoryHeader
					chat={activeChat}
					cast={activeCast}
					isGenerating={isGenerating}
					onOpenCast={() => togglePanel("cast")}
				/>

				<div className="story-scroll" ref={storyScrollRef}>
					<div className="story-content">
						{messages.length === 0 && (
							<EmptyChat cast={activeCast} />
						)}
						{messages.map((message) => (
							<StoryMessageView
								key={message.id}
								message={message}
								author={identitiesById.get(message.authorId)}
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
					identities={initialWorkspace.identities}
					currentIdentity={currentIdentity}
					draft={draft}
					isGenerating={isGenerating}
					canWrite={false}
					isReceded={composerIsReceded}
					onDraftChange={setDraft}
					onIdentityChange={setIdentityId}
					onFocusChange={setIsComposerFocused}
					onSubmit={submitMessage}
				/>
			</main>

			<MessageDetailsPanel
				message={detailMessage}
				author={detailMessage ? identitiesById.get(detailMessage.authorId) : undefined}
				onClose={() => setDetailMessageId(null)}
			/>
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
				<RailButton label="Library" disabled>
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
	activeCast,
	theme,
	onThemeChange,
	onSelectChat,
	onClose,
}: {
	panel: PrimaryPanel;
	workspace: Workspace;
	activeChat: ChatSummary;
	activeCast: Identity[];
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
	onSelectChat: (chatId: string) => void;
	onClose: () => void;
}) {
	return (
		<aside className="primary-panel" data-open={Boolean(panel)} aria-hidden={!panel}>
			{panel && (
				<>
					<PanelHeader
						title={panel === "chats" ? "Chats" : panel === "cast" ? "Cast" : "Settings"}
						onClose={onClose}
					/>
					{panel === "chats" && (
						<ChatsPanel
							chats={workspace.chats}
							activeId={activeChat.id}
							onSelect={onSelectChat}
						/>
					)}
					{panel === "cast" && (
						<CastPanel identities={activeCast} />
					)}
					{panel === "settings" && (
						<SettingsPanel theme={theme} onThemeChange={onThemeChange} />
					)}
				</>
			)}
		</aside>
	);
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
	return (
		<header className="panel-header">
			<button className="mobile-back" type="button" onClick={onClose} aria-label="Back to Chat">
				<ArrowLeft aria-hidden="true" />
			</button>
			<h2>{title}</h2>
			<button className="icon-button desktop-close" type="button" onClick={onClose} aria-label={`Close ${title}`}>
				<PanelLeftClose aria-hidden="true" />
			</button>
		</header>
	);
}

function ChatsPanel({
	chats,
	activeId,
	onSelect,
}: {
	chats: ChatSummary[];
	activeId: string;
	onSelect: (chatId: string) => void;
}) {
	const [query, setQuery] = useState("");
	const filteredChats = chats.filter((chat) =>
		chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
	);

	return (
		<div className="panel-body">
			<label className="search-field">
				<Search aria-hidden="true" />
				<span className="sr-only">Search Chats</span>
				<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Chats" />
			</label>
			<div className="chat-list">
				{filteredChats.map((chat) => (
					<button
						className="chat-list-item"
						data-active={chat.id === activeId}
						type="button"
						key={chat.id}
						onClick={() => onSelect(chat.id)}
					>
						<span>{chat.title}</span>
						<small>{chat.id === activeId ? "Open now" : chat.updatedAt}</small>
					</button>
				))}
			</div>
		</div>
	);
}

function CastPanel({ identities }: { identities: Identity[] }) {
	return (
		<div className="panel-body cast-panel-body">
			<p className="panel-intro">Characters currently present in this Chat.</p>
			<div className="cast-list">
				{identities.map((identity) => (
					<div className="cast-member" key={identity.id}>
						<Portrait identity={identity} size="large" />
						<div>
							<strong>{identity.name}</strong>
							<span>Character profile</span>
						</div>
						<button type="button" className="icon-button" aria-label={`View ${identity.name}`} disabled>
							<ChevronRight aria-hidden="true" />
						</button>
					</div>
				))}
			</div>
			<button className="secondary-button" type="button" disabled>
				Edit Cast
			</button>
			<p className="panel-note">Cast editing will connect here when participant RPCs are available.</p>
		</div>
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
	cast,
	isGenerating,
	onOpenCast,
}: {
	chat: ChatSummary;
	cast: Identity[];
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
				<span className="portrait-stack" aria-hidden="true">
					{cast.slice(0, 3).map((identity) => (
						<Portrait key={identity.id} identity={identity} size="small" />
					))}
				</span>
				<span>Cast</span>
				<ChevronDown aria-hidden="true" />
			</button>
		</header>
	);
}

function EmptyChat({ cast }: { cast: Identity[] }) {
	return (
		<section className="empty-chat">
			{cast.length > 0 && (
				<div className="empty-chat-cast" aria-label="Current Cast">
					{cast.map((identity) => (
						<div key={identity.id}>
							<Portrait identity={identity} size="large" />
							<span>{identity.name}</span>
						</div>
					))}
				</div>
			)}
			<h2>This Chat has no stored Messages yet</h2>
			<p>Chat and Cast are connected. Writing will become available when Message storage is added.</p>
		</section>
	);
}

function StoryMessageView({
	message,
	author,
	onMoveSwipe,
	onShowDetails,
	onUpdate,
}: {
	message: StoryMessage;
	author?: Identity;
	onMoveSwipe: (messageId: string, direction: -1 | 1) => void;
	onShowDetails: (messageId: string) => void;
	onUpdate: (messageId: string, text: string) => void;
}) {
	if (message.type === "writer") {
		return (
			<article className="writer-message">
				<header>
					<span>{author?.name ?? "Writer"}</span>
					<time>{message.createdAt}</time>
				</header>
				<p>{message.text}</p>
			</article>
		);
	}

	return (
		<GeneratedStoryMessage
			message={message}
			author={author}
			onMoveSwipe={onMoveSwipe}
			onShowDetails={onShowDetails}
			onUpdate={onUpdate}
		/>
	);
}

function GeneratedStoryMessage({
	message,
	author,
	onMoveSwipe,
	onShowDetails,
	onUpdate,
}: {
	message: GeneratedMessage;
	author?: Identity;
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
				<Portrait identity={author} size="medium" />
				<div className="message-author">
					<strong>{author?.name ?? "Unknown author"}</strong>
					<div className="message-meta">
						<span>{message.generation.profile}</span>
						<time>{message.createdAt}</time>
					</div>
				</div>
				<div className="advanced-actions">
					<button className="icon-button" type="button" onClick={() => onShowDetails(message.id)} aria-label={`Details for ${author?.name ?? "Message"}`}>
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
	identities,
	currentIdentity,
	draft,
	isGenerating,
	canWrite,
	isReceded,
	onDraftChange,
	onIdentityChange,
	onFocusChange,
	onSubmit,
}: {
	identities: Identity[];
	currentIdentity: Identity;
	draft: string;
	isGenerating: boolean;
	canWrite: boolean;
	isReceded: boolean;
	onDraftChange: (value: string) => void;
	onIdentityChange: (id: string) => void;
	onFocusChange: (focused: boolean) => void;
	onSubmit: (event: FormEvent) => void;
}) {
	const [isIdentityOpen, setIsIdentityOpen] = useState(false);

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
					setIsIdentityOpen(false);
				}
			}}
		>
			<div className="identity-picker">
				<button type="button" className="identity-button" onClick={() => setIsIdentityOpen((current) => !current)} aria-expanded={isIdentityOpen} aria-haspopup="menu">
					<Portrait identity={currentIdentity} size="medium" />
					<span>
						<small>Writing as</small>
						<strong>{currentIdentity.name}</strong>
					</span>
					<ChevronDown aria-hidden="true" />
				</button>
				{isIdentityOpen && (
					<div className="identity-menu" role="menu">
						{identities.map((identity) => (
							<button
								type="button"
								role="menuitem"
								key={identity.id}
								onClick={() => {
									onIdentityChange(identity.id);
									setIsIdentityOpen(false);
								}}
							>
								<Portrait identity={identity} size="medium" />
								<span>
									<strong>{identity.name}</strong>
									<small>{identity.kind === "writer" ? "Guide the next Message" : "Write in character"}</small>
								</span>
								{identity.id === currentIdentity.id && <Check aria-hidden="true" />}
							</button>
						))}
					</div>
				)}
			</div>
			<label htmlFor="writer-message" className="sr-only">
				{currentIdentity.kind === "writer" ? "Writer Message" : `Message as ${currentIdentity.name}`}
			</label>
			<textarea
				id="writer-message"
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
				placeholder={
					canWrite
						? currentIdentity.kind === "writer"
							? "Guide what happens next..."
							: `Write as ${currentIdentity.name}...`
						: "Message storage is not available yet"
				}
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
	author,
	onClose,
}: {
	message?: GeneratedMessage;
	author?: Identity;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel" data-open={Boolean(message)} aria-hidden={!message}>
			{message && (
				<>
					<PanelHeader title="Message details" onClose={onClose} />
					<div className="panel-body details-body">
						<section className="author-detail">
							<Portrait identity={author} size="large" />
							<div>
								<span>Author</span>
								<strong>{author?.name ?? "Unknown author"}</strong>
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

function Portrait({ identity, size }: { identity?: Identity; size: "small" | "medium" | "large" }) {
	const initial = identity?.name.trim().charAt(0).toLocaleUpperCase() ?? "?";
	return (
		<span className="portrait" data-size={size} aria-hidden="true">
			{identity?.portraitUrl ? <img src={identity.portraitUrl} alt="" /> : <span>{initial}</span>}
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

function WorkspaceWithoutChats() {
	return (
		<main className="workspace-error">
			<div>
				<MessageSquare aria-hidden="true" />
				<h1>No Chats found</h1>
				<p>Create or seed a Chat to open the writing workspace.</p>
			</div>
		</main>
	);
}
