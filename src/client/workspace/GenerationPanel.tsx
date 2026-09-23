import { SlidersHorizontal } from "lucide-react";
import { AppSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import type { ConversationSummary } from "../conversation";
import { generationSettingsSummaryFromDrafts } from "../generation-settings-draft";
import { BudgetEditor } from "./GenerationSettingsEditors";
import type { GenerationSettingsDraftController } from "./useGenerationSettingsDraft";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard } from "../SaveGuard";

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
		dirty,
		save,
		discard,
		samplingDrafts,
		budgetDrafts,
		updateBudget,
		overridesDrafts,
	} = controller;
	useSaveGuard({ dirty, saving: status === "saving", save, discard });

	const summary = generationSettingsSummaryFromDrafts(
		{ sampling: samplingDrafts, budget: budgetDrafts, overrides: overridesDrafts },
		transmittingNamespace.status === "known" ? transmittingNamespace.namespace : null,
	);

	return (
		<><div className="panel-body settings-panel-body">
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
						<Field htmlFor="continuation-strategy" label="Strategy">
						<AppSelect
								id="continuation-strategy"
								className="field-input"
								value={strategy}
								onValueChange={(value) => setStrategy(value === "assistant-prefill" ? "assistant-prefill" : "instruction")}
								options={[{ value: "instruction", label: "Instruction" }, { value: "assistant-prefill", label: "Assistant prefill" }]}
							/>
						</Field>
						{strategy === "assistant-prefill" && (
							<Field htmlFor="continuation-prefill-suffix" label="Prefill suffix">
								<AppSelect
									id="continuation-prefill-suffix"
									className="field-input"
									value={prefillSuffix}
									onValueChange={(value) => setPrefillSuffix(value === " " || value === "\n" || value === "\n\n" ? value : "")}
									emptyLabel="None"
									options={[{ value: " ", label: "Space" }, { value: "\n", label: "Newline" }, { value: "\n\n", label: "Double newline" }]}
								/>
							</Field>
						)}
						<Field htmlFor="continuation-instruction" label="Continuation instruction" helper={strategy === "assistant-prefill" && "Ignored while the Assistant prefill strategy is active."}>
							<textarea
								id="continuation-instruction"
								value={instruction}
								rows={3}
								onChange={(event) => updateInstruction(event.target.value)}
							/>
						</Field>
					</section>

					<BudgetEditor drafts={budgetDrafts} onChange={updateBudget} />

					<section className="generation-settings-summary" aria-labelledby="generation-summary-title">
						<div className="settings-summary-heading">
							<div>
								<h3 id="generation-summary-title">Advanced settings</h3>
								<p>Sampling and Request Overrides are ready in the inspector.</p>
							</div>
							<SlidersHorizontal aria-hidden="true" />
						</div>
						<dl className="settings-summary-list">
							<div><dt>Sampling</dt><dd>{summary.sampling}</dd></div>
							<div><dt>Request Overrides</dt><dd>{summary.overrides}</dd></div>
							<div><dt>Transmitted namespace</dt><dd>{summary.transmittingNamespace}</dd></div>
						</dl>
						<button className="secondary-button settings-inspector-entry" type="button" onClick={onOpenInspector}>
							<SlidersHorizontal aria-hidden="true" /> Edit in inspector
						</button>
					</section>

				</div>
			)}
		</div><SaveFooter dirty={dirty} saving={status === "saving"} valid={canSave} error={problem} onSave={() => void save()} /></>
	);
}
