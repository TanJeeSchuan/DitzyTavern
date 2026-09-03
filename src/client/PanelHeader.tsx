import { ArrowLeft, PanelLeftClose } from "lucide-react";

// ==[HUMAN APPROVED]== Shared primary/details panel header: the Back control appears on narrow
// widths where the panel becomes a full-screen layer, and the desktop
// close control hides there. Panel nesting (for example Import Chat inside
// the Chats panel) renders its own header instead.
export function PanelHeader({
	title,
	backLabel = "Back to Chat",
	onClose,
}: {
	title: string;
	backLabel?: string;
	onClose: () => void;
}) {
	return (
		<header className="panel-header">
			<button
				className="mobile-back"
				type="button"
				onClick={onClose}
				aria-label={backLabel}
			>
				<ArrowLeft aria-hidden="true" />
			</button>
			<h2>{title}</h2>
			<button
				className="icon-button desktop-close"
				type="button"
				onClick={onClose}
				aria-label={`Close ${title}`}
			>
				<PanelLeftClose aria-hidden="true" />
			</button>
		</header>
	);
}
