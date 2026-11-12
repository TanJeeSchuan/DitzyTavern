import { ArrowLeft, PanelLeftClose } from "lucide-react";
import type { ReactNode } from "react";

// @approved
//  Shared primary/details panel header: the Back control appears on narrow
// widths where the panel becomes a full-screen layer, and the desktop
// close control hides there. Nested panels show Back on every screen size.
export function PanelHeader({
	title,
	backLabel = "Back to Chat",
	nested = false,
	actions,
	onClose,
}: {
	title: string;
	backLabel?: string;
	nested?: boolean;
	actions?: ReactNode;
	onClose: () => void;
}) {
	return (
		<header className="panel-header">
			<button
				className={nested ? "icon-button" : "mobile-back"}
				type="button"
				onClick={onClose}
				aria-label={backLabel}
			>
				<ArrowLeft aria-hidden="true" />
			</button>
			<h2>{title}</h2>
			<div className="panel-header-actions">
				{actions}
				{!nested && <button
					className="icon-button desktop-close"
					type="button"
					onClick={onClose}
					aria-label={`Close ${title}`}
				>
					<PanelLeftClose aria-hidden="true" />
				</button>}
			</div>
		</header>
	);
}
