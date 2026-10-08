import type { StagedChatHandle } from "../import-chat-flow";
import { sourceSize } from "./presentation";

// @approved
//  The one Source card shared by the Import flow's resolution and
// review steps. The declared-integrity row stays a resolution-step display:
// the review step keeps its exact previous layout.
export function SourceCard({
	handle,
	counts,
	showDeclaredIntegrity = false,
}: {
	handle: StagedChatHandle | null;
	counts: { messages: number; variants: number } | null;
	showDeclaredIntegrity?: boolean;
}) {
	return (
		<section className="import-source">
			<h3>Source</h3>
			<dl className="detail-list import-meta-list">
				<div>
					<dt>Original filename</dt>
					<dd>{handle?.originalFilename}</dd>
				</div>
				<div>
					<dt>SHA-256</dt>
					<dd className="import-sha">{handle?.sha256}</dd>
				</div>
				<div>
					<dt>Size</dt>
					<dd>{sourceSize(handle?.byteLength ?? null)}</dd>
				</div>
				{showDeclaredIntegrity && handle?.integrity !== null && handle?.integrity !== undefined && (
					<div>
						<dt>Declared integrity</dt>
						<dd className="import-sha">{handle?.integrity}</dd>
					</div>
				)}
				<div>
					<dt>Messages</dt>
					<dd>{counts?.messages ?? 0}</dd>
				</div>
				<div>
					<dt>Variants</dt>
					<dd>{counts?.variants ?? 0}</dd>
				</div>
			</dl>
		</section>
	);
}
