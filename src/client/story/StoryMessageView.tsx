import {
	ChevronLeft,
	ChevronRight,
	Edit3,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	type StoryMessage,
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

