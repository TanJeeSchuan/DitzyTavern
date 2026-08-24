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
				Import one SillyTavern export. Its contents are validated before
				anything is created, and nothing is saved until you finish the
				final review step.
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
				The file is uploaded once into a temporary staged import. A server
				restart expires the staged flow and requires reselecting the file.
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
				Malformed JSON, invalid UTF-8, and structural defects are reported
				here before any resolution begins.
			</p>
		</div>
	);
}

export function CommittingStep() {
	return (
		<div className="import-staging" role="status" aria-live="polite">
			<Loader2 className="import-spinner" aria-hidden="true" />
			<strong>Committing the import</strong>
			<p>
				The Chat, requested new Characters, Participants, Messages, and the
				exact preserved source commit together as one operation.
			</p>
		</div>
	);
}

