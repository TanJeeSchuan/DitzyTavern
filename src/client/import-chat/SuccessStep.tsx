import { Check } from "lucide-react";
import type { ChatImportReceipt } from "../import-chat";
import { sourceSize } from "./presentation";

// ---- Success receipt ----

export function SuccessStep({
	receipt,
	onOpen,
	onClose,
}: {
	receipt: ChatImportReceipt | null;
	onOpen: () => void;
	onClose: () => void;
}) {
	if (receipt === null) {
		return (
			<div className="import-success">
				<p className="import-problem" role="alert">
					The import finished, but its details are unavailable. You can find
					the Chat in the Chats panel.
				</p>
				<button className="primary-button" type="button" onClick={onClose}>
					Close
				</button>
			</div>
		);
	}
	return (
		<div className="import-success">
			<div className="import-success-mark" aria-hidden="true">
				<Check />
			</div>
			<h3>Chat imported</h3>
			<p className="panel-intro">
				<strong>{receipt.title}</strong> was imported with{" "}
				{receipt.counts.messages} Message{receipt.counts.messages === 1 ? "" : "s"}{" "}
				and {receipt.counts.variants} Variant
				{receipt.counts.variants === 1 ? "" : "s"} from{" "}
				{receipt.originalFilename}.
			</p>

			<dl className="detail-list import-meta-list">
				<div>
					<dt>Chat</dt>
					<dd>{receipt.conversationId}</dd>
				</div>
				<div>
					<dt>SHA-256</dt>
					<dd className="import-sha">{receipt.sha256}</dd>
				</div>
				<div>
					<dt>Size</dt>
					<dd>{sourceSize(receipt.byteLength)}</dd>
				</div>
			</dl>

			<section className="import-review-participants">
				<h3>Participants</h3>
				<ul>
					{receipt.participants.map((participant, index) => (
						<li key={`${participant.name}-${index}`}>
							<span className="import-review-name">{participant.name}</span>
							<span className="import-review-outcome">
								{participant.outcome === "fork"
									? "Existing Character"
									: participant.outcome === "new-character"
										? "New Character"
										: "Chat-only"}
							</span>
						</li>
					))}
				</ul>
			</section>

			{receipt.warnings.length > 0 && (
				<section className="import-warnings">
					<h3>Warnings</h3>
					<ul>
						{receipt.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</section>
			)}

			<div className="import-success-actions">
				<button className="primary-button" type="button" onClick={onOpen}>
					Open Chat
				</button>
				<button className="secondary-button" type="button" onClick={onClose}>
					Close
				</button>
			</div>
		</div>
	);
}

