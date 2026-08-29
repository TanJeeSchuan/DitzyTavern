import { JsonEditor } from "json-edit-react";
import {
	type ContinuationPrefillSuffix,
	type ConversationGenerationSettings,
	type ConversationSummary,
} from "../conversation";
import {
	BUDGET_FIELDS,
	BUDGET_FIELD_ERROR,
	BUDGET_FIELD_LABELS,
	collidingSamplingOverrideKeys,
	managedOverrideKeys,
	OVERRIDES_DRAFT_ERROR,
	OVERRIDES_NAMESPACE_LABELS,
	OVERRIDES_NAMESPACES,
	parseBudgetDraft,
	parseOverridesDraft,
	parseSamplingDraft,
	SAMPLING_DRAFT_ERROR,
	SAMPLING_FIELDS,
	SAMPLING_FIELD_LABELS,
} from "../generation-settings-draft";
import { useGenerationSettingsDraft } from "./useGenerationSettingsDraft";

function continuationStrategyValue(
	value: string,
): ConversationGenerationSettings["continuationStrategy"] {
	return value === "assistant-prefill" ? value : "instruction";
}

function continuationPrefillSuffixValue(value: string): ContinuationPrefillSuffix {
	return value === " " || value === "\n" || value === "\n\n" ? value : "";
}

export function GenerationPanel({
	conversation,
	onConversationChange,
}: {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
}) {
	if (conversation === null) {
		return (
			<div className="panel-body">
				<p className="panel-note">Open a Chat to edit its Generation settings.</p>
			</div>
		);
	}
	return (
		<GenerationSettings
			conversation={conversation}
			onConversationChange={(next) => onConversationChange(next)}
		/>
	);
}

function GenerationSettings({
	conversation,
	onConversationChange,
}: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
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
		samplingDrafts,
		updateSampling,
		budgetDrafts,
		updateBudget,
		overridesDrafts,
		updateOverrides,
		updateInstruction,
		canSave,
		save,
	} = useGenerationSettingsDraft({
		conversation,
		onConversationChange,
	});

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
					<section aria-labelledby="generation-sampling-title">
						<h3 id="generation-sampling-title">Sampling</h3>
						<p>Optional values sent with every request. An empty field uses the provider default.</p>
						{SAMPLING_FIELDS.map((field) => {
							const parsed = parseSamplingDraft(samplingDrafts[field]);
							return (
								<div className="field" key={field}>
									<label htmlFor={`generation-${field}`}>{SAMPLING_FIELD_LABELS[field]}</label>
									<input
										id={`generation-${field}`}
										className="field-input"
										inputMode="decimal"
										autoComplete="off"
										placeholder="Provider default"
										value={samplingDrafts[field]}
										onChange={(event) => updateSampling(field, event.target.value)}
									/>
									{parsed.status === "invalid" && (
										<small className="field-error" role="alert">{SAMPLING_DRAFT_ERROR}</small>
									)}
								</div>
							);
						})}
					</section>
					<section aria-labelledby="generation-budget-title">
						<h3 id="generation-budget-title">Budget</h3>
						<p>Limits applied to the next Generation and its Swipes.</p>
						{BUDGET_FIELDS.map((field) => {
							const parsed = parseBudgetDraft(field, budgetDrafts[field]);
							return (
								<div className="field" key={field}>
									<label htmlFor={`generation-${field}`}>{BUDGET_FIELD_LABELS[field]}</label>
									<input
										id={`generation-${field}`}
										className="field-input"
										inputMode="numeric"
										autoComplete="off"
										value={budgetDrafts[field]}
										onChange={(event) => updateBudget(field, event.target.value)}
									/>
									{parsed.status === "invalid" && (
										<small className="field-error" role="alert">{BUDGET_FIELD_ERROR[field]}</small>
									)}
								</div>
							);
						})}
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
								onChange={(event) => setStrategy(continuationStrategyValue(event.target.value))}
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
									onChange={(event) => setPrefillSuffix(continuationPrefillSuffixValue(event.target.value))}
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
					<section aria-labelledby="generation-overrides-title">
						<h3 id="generation-overrides-title">Request Overrides</h3>
						<p>
							Extra request body fields for this Chat, kept per API Format. Only
							the namespace of the active Connection Profile is transmitted; the
							others stay editable and are never sent.
						</p>
						{transmittingNamespace.status === "unavailable" && (
							<small className="overrides-namespace-status" role="note">
								Connection Settings could not be loaded, so the transmitted
								namespace is unknown.
							</small>
						)}
						{transmittingNamespace.status === "no-active-profile" && (
							<small className="overrides-namespace-status" role="note">
								No Connection Profile is active, so no namespace is transmitted.
							</small>
						)}
						{OVERRIDES_NAMESPACES.map((namespace) => {
							const parsed = parseOverridesDraft(overridesDrafts[namespace]);
							const overrides = parsed.status === "valid" ? parsed.value : {};
							const colliding = collidingSamplingOverrideKeys(overrides);
							const managed = managedOverrideKeys(namespace, overrides);
							const transmitting =
								transmittingNamespace.status === "known" &&
								transmittingNamespace.namespace === namespace;
							return (
								<div className="overrides-namespace" key={namespace}>
									<div className="overrides-namespace-heading">
										<h4>{OVERRIDES_NAMESPACE_LABELS[namespace]}</h4>
										{transmittingNamespace.status === "known" ||
										transmittingNamespace.status === "no-active-profile" ? (
											<span data-transmitting={transmitting}>
												{transmitting ? "Transmitted" : "Not transmitted"}
											</span>
										) : null}
									</div>
									<div className="overrides-namespace-editor">
										<JsonEditor
											data={overridesDrafts[namespace]}
											setData={(value) => updateOverrides(namespace, value)}
											rootName={OVERRIDES_NAMESPACE_LABELS[namespace]}
											collapse={transmitting ? false : 1}
											restrictDrag
											showStringQuotes={false}
											showIconTooltips
											rootFontSize={13}
											maxWidth="100%"
										/>
									</div>
									{transmitting && colliding.length > 0 && (
										<small className="overrides-notice" role="note">
											These keys override the Sampling fields with the same names
											when the request is built: {colliding.join(", ")}.
										</small>
									)}
									{managed.structural.map((key) => (
										<small className="overrides-notice" key={key} role="note">
											The app manages "{key}" on every request, so this override
											is never sent.
										</small>
									))}
									{managed.outputLimit.map((key) => (
										<small className="overrides-notice" key={key} role="note">
											The response budget sets the output limit, so the "{key}"
											override is never sent.
										</small>
									))}
									{parsed.status === "invalid" && (
										<small className="field-error" role="alert">
											{OVERRIDES_DRAFT_ERROR}
										</small>
									)}
								</div>
							);
						})}
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
