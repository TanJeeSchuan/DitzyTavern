import { SlidersHorizontal } from "lucide-react";
import type { ConversationSummary } from "../conversation";
import { generationSettingsSummaryFromDrafts } from "../generation-settings-draft";
import type { GenerationSettingsDraftController } from "./useGenerationSettingsDraft";

export function GenerationPanel({
	conversation,
	controller,
	onOpenInspector,
}: {
	conversation: ConversationSummary | null;
	controller: GenerationSettingsDraftController;
	onOpenInspector: () => void;
}) {
	if (conversation === null) {
		return (
			<div className="panel-body">
				<p className="panel-note">Open a Chat to edit its Generation settings.</p>
			</div>
		);
	}
	return <GenerationSettings controller={controller} onOpenInspector={onOpenInspector} />;
}

function GenerationSettings({
	controller,
	onOpenInspector,
}: {
	controller: GenerationSettingsDraftController;
	onOpenInspector: () => void;
}) {
	const {
		settings,
		status,
		problem,
		transmittingNamespace,
		instruction,
		strategy,
		setStrategy,
		prefillSuffix,
		setPrefillSuffix,
		updateInstruction,
		canSave,
		save,
		samplingDrafts,
		budgetDrafts,
		overridesDrafts,
	} = controller;

	const summary = generationSettingsSummaryFromDrafts(
		{ sampling: samplingDrafts, budget: budgetDrafts, overrides: overridesDrafts },
		transmittingNamespace.status === "known" ? transmittingNamespace.namespace : null,
	);

	return (
		<div className="panel-body settings-panel-body">
			{settings !== null && problem !== null && (
				<p className="import-problem" role="alert">{problem}</p>
			)}
			{status === "load-error" && (
				<p className="import-problem" role="alert">Generation Settings could not be loaded.</p>
			)}
			{settings !== null && status !== "load-error" && (
				<div className="definition-form">
					<section aria-labelledby="generation-model-title">
						<h3 id="generation-model-title">Model</h3>
						<div className="field">
							<span className="generation-model-value">{settings.modelId}</span>
							<small>The model ID is chosen beside the composer.</small>
						</div>
					</section>

					<section aria-labelledby="continuation-settings-title">
						<h3 id="continuation-settings-title">Continuation</h3>
						<p>How the next model Message continues after a length limit.</p>
						<div className="field">
							<label htmlFor="continuation-strategy">Strategy</label>
							<select
								id="continuation-strategy"
								className="field-input"
								value={strategy}
								onChange={(event) => setStrategy(event.target.value === "assistant-prefill" ? "assistant-prefill" : "instruction")}
							>
								<option value="instruction">Instruction</option>
								<option value="assistant-prefill">Assistant prefill</option>
							</select>
						</div>
						{strategy === "assistant-prefill" && (
							<div className="field">
								<label htmlFor="continuation-prefill-suffix">Prefill suffix</label>
								<select
									id="continuation-prefill-suffix"
									className="field-input"
									value={prefillSuffix}
									onChange={(event) => setPrefillSuffix(event.target.value === " " || event.target.value === "\n" || event.target.value === "\n\n" ? event.target.value : "")}
								>
									<option value="">None</option>
									<option value=" ">Space</option>
									<option value="\n">Newline</option>
									<option value="\n\n">Double newline</option>
								</select>
							</div>
						)}
						<div className="field">
							<label htmlFor="continuation-instruction">Continuation instruction</label>
							<textarea
								id="continuation-instruction"
								value={instruction}
								rows={3}
								onChange={(event) => updateInstruction(event.target.value)}
							/>
							{strategy === "assistant-prefill" && (
								<small>Ignored while the Assistant prefill strategy is active.</small>
							)}
						</div>
					</section>

					<section className="generation-settings-summary" aria-labelledby="generation-summary-title">
						<div className="settings-summary-heading">
							<div>
								<h3 id="generation-summary-title">Advanced settings</h3>
								<p>Sampling, Budget, and Request Overrides are ready in the inspector.</p>
							</div>
							<SlidersHorizontal aria-hidden="true" />
						</div>
						<dl className="settings-summary-list">
							<div><dt>Sampling</dt><dd>{summary.sampling}</dd></div>
							<div><dt>Budget</dt><dd>{summary.budget}</dd></div>
							<div><dt>Request Overrides</dt><dd>{summary.overrides}</dd></div>
							<div><dt>Transmitted namespace</dt><dd>{summary.transmittingNamespace}</dd></div>
						</dl>
						<button className="secondary-button settings-inspector-entry" type="button" onClick={onOpenInspector}>
							<SlidersHorizontal aria-hidden="true" /> Edit in inspector
						</button>
					</section>

					<button
						className="primary-button"
						type="button"
						disabled={!canSave}
						onClick={() => void save()}
					>
						{status === "saving" ? "Saving…" : "Save Generation settings"}
					</button>
				</div>
			)}
		</div>
	);
}
