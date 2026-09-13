import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Edit3,
	Info,
	RefreshCw,
} from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useState } from "react";
import {
	type StoryMessage,
	displayedVariantId as getDisplayedVariantId,
	visibleVariantContent,
} from "../story";
import { formatTimestamp } from "../lib/format";
import { GenerationSphere } from "./GenerationSphere";
import { Portrait } from "./Portrait";

// ==[HUMAN APPROVED]== The story renders one native Message from the paginated read model: the
// immutable Author Stamp name, the persisted selected Variant, and the
// existing Swipe navigation. Empty and duplicate Variants stay separate
// positions; an exact empty Variant renders a presentation-only placeholder
// and its stored text is never modified.
export function StoryMessageView({
	message,
	displayedVariantId,
	mutationsDisabled = false,
	generationActive = false,
	previewDownstream = false,
	previewTarget = false,
	onMoveSwipe,
	onEdit,
	canContinue = false,
	continueLabel = "Continue",
	onContinue,
	onSibling,
	onInspect,
}: {
	message: StoryMessage;
	// ==[HUMAN APPROVED]== Preview mode supplies a local Variant id for its one target Message.
	// Persisted activeSwipe remains untouched until Confirm Change succeeds.
	displayedVariantId?: number | null;
	mutationsDisabled?: boolean;
	generationActive?: boolean;
	// ==[HUMAN APPROVED]== Causally downstream of the previewed Variant: the stored text stays
	// readable but dimmed and non-interactive until the Preview is confirmed
	// or cancelled.
	previewDownstream?: boolean;
	// ==[HUMAN APPROVED]== This Message is the Preview target: its Swipe controls stay enabled so
	// Variants can be compared freely without server commands, while every
	// other mutation remains locked.
	previewTarget?: boolean;
	onMoveSwipe: (messageId: number, direction: -1 | 1) => void;
	onEdit: (messageId: number, content: string) => void;
	canContinue?: boolean;
	continueLabel?: string;
	onContinue?: (messageId: number) => void;
	onSibling?: (messageId: number) => void;
	onInspect?: (messageId: number, variantId: number) => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [advancedActionsSelected, setAdvancedActionsSelected] = useState(false);
	const visibleId = displayedVariantId ?? getDisplayedVariantId(message, null);
	const active = message.swipes.find((variant) => variant.id === visibleId);
	const activeIndex = active === undefined
		? message.activeSwipe
		: message.swipes.findIndex((variant) => variant.id === active.id);
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
			tabIndex={0}
			data-message-id={message.id}
			data-author-in-cast={message.inCast}
			data-previewing={displayedVariantId !== undefined}
			data-preview-downstream={previewDownstream}
			inert={previewDownstream || undefined}
			data-selected={advancedActionsSelected}
			onPointerUp={(event) => {
				if (event.pointerType !== "touch") return;
				if (event.target instanceof Element && event.target.closest("button, textarea, input")) return;
				event.currentTarget.focus({ preventScroll: true });
				setAdvancedActionsSelected(true);
			}}
			onBlur={(event) => {
				if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
					setAdvancedActionsSelected(false);
				}
			}}
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
				<div className="advanced-actions" aria-label="Advanced Message actions">
					{onSibling !== undefined && (
						<button
							className="edit-action"
							type="button"
							disabled={mutationsDisabled}
							onClick={() => onSibling(message.id)}
						>
							<RefreshCw aria-hidden="true" /> New Swipe
						</button>
					)}
					{onInspect !== undefined && active !== undefined && (
						<button
							className="edit-action"
							type="button"
							onClick={() => onInspect(message.id, active.id)}
						>
							<Info aria-hidden="true" /> Details
						</button>
					)}
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
							disabled={mutationsDisabled}
							onClick={() => setIsEditing(false)}
						>
							Cancel
						</button>
						<button
							className="primary-button"
							type="button"
							disabled={mutationsDisabled}
							onClick={saveEdit}
						>
							Save
						</button>
					</div>
				</div>
			) : (
				<>
					{active?.reasoning !== undefined && active.reasoning !== "" && (
						<Collapsible.Root className="reasoning-content" aria-label="Reasoning Content">
							<Collapsible.Trigger className="reasoning-trigger">
								<strong>Reasoning</strong>
								<ChevronDown aria-hidden="true" />
							</Collapsible.Trigger>
							<Collapsible.Content className="reasoning-body">
								{active.reasoning
									.split("\n\n")
									.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
							</Collapsible.Content>
						</Collapsible.Root>
					)}
					<div
						className="prose"
						data-empty-variant={active?.empty === true && !generationActive}
						data-generation-active={generationActive}
					>
						{active !== undefined && !(generationActive && active.empty)
							? visibleVariantContent(active)
									.split("\n\n")
									.map((paragraph, index) => <p key={index}>{paragraph}</p>)
							: null}
						{generationActive && <GenerationSphere authorName={authorName} />}
					</div>
				</>
			)}

			<footer className="message-actions">
				<button
					className="edit-action"
					type="button"
					disabled={mutationsDisabled}
					onClick={() => setIsEditing(true)}
				>
					<Edit3 aria-hidden="true" /> Edit
				</button>
				{canContinue && onContinue !== undefined && (
					<button
						className="secondary-button continue-action"
						type="button"
						disabled={mutationsDisabled}
						onClick={() => onContinue(message.id)}
					>
						{continueLabel}
					</button>
				)}
				<div className="swipe-controls" aria-label="Swipe controls">
					<button
						className="icon-button"
						type="button"
						onClick={() => onMoveSwipe(message.id, -1)}
						disabled={(mutationsDisabled && !previewTarget) || activeIndex === 0}
						aria-label="Previous Swipe"
					>
						<ChevronLeft aria-hidden="true" />
					</button>
					<span>
						{activeIndex + 1} of {message.swipes.length}
					</span>
					<button
						className="icon-button"
						type="button"
						onClick={() => onMoveSwipe(message.id, 1)}
						disabled={
							(mutationsDisabled && !previewTarget) ||
							activeIndex === message.swipes.length - 1
						}
						aria-label="Next Swipe"
					>
						<ChevronRight aria-hidden="true" />
					</button>
				</div>
			</footer>
		</article>
	);
}
