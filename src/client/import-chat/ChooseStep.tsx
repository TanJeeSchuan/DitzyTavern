import { Loader2, Upload } from "lucide-react";
import type { ChatImportFlowState } from "../import-chat-flow";

export function ChooseStep({
	flow,
	onPick,
}: {
	flow: ChatImportFlowState;
	onPick: () => void;
}) {
	return (
		<div className="import-choose">
			<p className="panel-intro">
				Choose a SillyTavern export. Validated before creating anything.
				Nothing is saved until you finish the final review.
			</p>

			<button className="import-file-button" type="button" onClick={onPick}>
				<span className="import-file-icon">
					<Upload aria-hidden="true" />
				</span>
				<strong>Choose a SillyTavern export</strong>
				<small>One file, any extension. JSONL is preferred.</small>
			</button>

			{flow.problem !== null && (
				<p className="import-problem" role="alert">
					{flow.problem}
				</p>
			)}

			<p className="panel-note">
				The file uploads once for this import. If the server restarts, choose
				the file again.
			</p>
		</div>
	);
}

export function StagingStep() {
	return (
		<div className="import-staging" role="status" aria-live="polite">
			<Loader2 className="import-spinner" aria-hidden="true" />
			<strong>Uploading and validating the export</strong>
			<p>
				We check the file format before you resolve Participants. Any errors
				appear here.
			</p>
		</div>
	);
}

export function CommittingStep() {
	return (
		<div className="import-staging" role="status" aria-live="polite">
			<Loader2 className="import-spinner" aria-hidden="true" />
			<strong>Saving the import</strong>
			<p>
				Your Chat, Participants, new Characters, Messages, and original file
				are saved together.
			</p>
		</div>
	);
}

