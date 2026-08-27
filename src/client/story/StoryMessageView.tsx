import {
	ChevronLeft,
	ChevronRight,
	Edit3,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	type StoryMessage,
	displayedVariantId as getDisplayedVariantId,
	visibleVariantContent,
} from "../story";
import { Portrait } from "./Portrait";

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
export function StoryMessageView({
	message,
	displayedVariantId,
	mutationsDisabled = false,
	onMoveSwipe,
	onEdit,
	canContinue = false,
	continueLabel = "Continue",
	onContinue,
	onSibling,
	onInspect,
}: {
	message: StoryMessage;
	// Preview mode supplies a local Variant id for its one target Message.
	// Persisted activeSwipe remains untouched until Confirm Change succeeds.
	displayedVariantId?: number | null;
	mutationsDisabled?: boolean;
	onMoveSwipe: (messageId: number, direction: -1 | 1) => void;
	onEdit: (messageId: number, content: string) => void;
	canContinue?: boolean;
	continueLabel?: string;
	onContinue?: (messageId: number) => void;
	onSibling?: (messageId: number) => void;
	onInspect?: (messageId: number, variantId: number) => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
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
			data-message-id={message.id}
			data-author-in-cast={message.inCast}
			data-previewing={displayedVariantId !== undefined}
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
				<div
					className="prose"
					data-empty-variant={active?.empty === true}
				>
					{active !== undefined
						? visibleVariantContent(active)
								.split("\n\n")
								.map((paragraph, index) => <p key={index}>{paragraph}</p>)
						: null}
				</div>
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
				{onSibling !== undefined && (
					<button
						className="edit-action"
						type="button"
						disabled={mutationsDisabled}
						onClick={() => onSibling(message.id)}
					>
						New Swipe
					</button>
				)}
				{onInspect !== undefined && active !== undefined && (
					<button
						className="edit-action"
						type="button"
						onClick={() => onInspect(message.id, active.id)}
					>
						Details
					</button>
				)}
				<div className="swipe-controls" aria-label="Swipe controls">
					<button
						className="icon-button"
						type="button"
						onClick={() => onMoveSwipe(message.id, -1)}
						disabled={mutationsDisabled || activeIndex === 0}
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
						disabled={mutationsDisabled || activeIndex === message.swipes.length - 1}
						aria-label="Next Swipe"
					>
						<ChevronRight aria-hidden="true" />
					</button>
				</div>
			</footer>
		</article>
	);
}
