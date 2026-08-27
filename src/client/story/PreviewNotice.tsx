import { PanelLeftClose } from "lucide-react";

export function PreviewNotice({
	targetPosition,
	pending,
	error,
	onConfirm,
	onCancel,
	onClose,
}: {
	targetPosition: number;
	pending: boolean;
	error: string | null;
	onConfirm: () => void;
	onCancel: () => void;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel preview-panel" data-open="true" aria-label="Preview mode">
			<header className="panel-header">
				<h2>Preview mode</h2>
				<button
					className="icon-button"
					type="button"
					aria-label="Close Preview notice"
					disabled={pending}
					onClick={onClose}
				>
					<PanelLeftClose aria-hidden="true" />
				</button>
			</header>
			<div className="panel-body preview-panel-body">
				<p className="preview-lead">
					You are viewing an older Variant locally. The Selected narrative path has not changed.
				</p>
				<p className="panel-note">
					Message {targetPosition} is previewed. Later Messages are dimmed until you confirm or cancel.
				</p>
				<div className="preview-actions">
					<button
						className="primary-button"
						type="button"
						disabled={pending}
						onClick={onConfirm}
					>
						{pending ? "Confirming Change…" : "Confirm Change"}
					</button>
					<button
						className="secondary-button"
						type="button"
						disabled={pending}
						onClick={onCancel}
					>
						Cancel Preview
					</button>
				</div>
				{error !== null && (
					<p className="preview-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</aside>
	);
}

export function PreviewIndicator({
	targetPosition,
	onOpen,
}: {
	targetPosition: number;
	onOpen: () => void;
}) {
	return (
		<div className="preview-indicator" role="status" data-preview-indicator="true">
			<span>Preview mode</span>
			<span className="preview-indicator-detail">Message {targetPosition}</span>
			<button className="secondary-button" type="button" onClick={onOpen}>
				Review Preview
			</button>
		</div>
	);
}
