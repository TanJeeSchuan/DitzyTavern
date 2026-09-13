import { JsonEditor } from "json-edit-react";
import {
	BUDGET_FIELDS,
	BUDGET_FIELD_ERROR,
	BUDGET_FIELD_LABELS,
	collidingSamplingOverrideKeys,
	managedOverrideKeys,
	OVERRIDES_DRAFT_ERROR,
	OVERRIDES_NAMESPACES,
	OVERRIDES_NAMESPACE_LABELS,
	parseBudgetDraft,
	parseOverridesDraft,
	parseSamplingDraft,
	SAMPLING_DRAFT_ERROR,
	SAMPLING_FIELDS,
	SAMPLING_FIELD_LABELS,
} from "../generation-settings-draft";
import type { GenerationSettingsDraftController } from "./useGenerationSettingsDraft";

type GenerationEditorController = Pick<
	GenerationSettingsDraftController,
	| "samplingDrafts"
	| "updateSampling"
	| "overridesDrafts"
	| "updateOverrides"
	| "transmittingNamespace"
>;

export function GenerationSecondaryEditors({
	controller,
}: {
	controller: GenerationEditorController;
}) {
	return (
		<>
			<SamplingEditor
				drafts={controller.samplingDrafts}
				onChange={controller.updateSampling}
			/>
			<RequestOverridesEditor
				drafts={controller.overridesDrafts}
				onChange={controller.updateOverrides}
				transmittingNamespace={controller.transmittingNamespace}
			/>
		</>
	);
}

export function SamplingEditor({
	drafts,
	onChange,
}: {
	drafts: GenerationEditorController["samplingDrafts"];
	onChange: GenerationEditorController["updateSampling"];
}) {
	return (
		<section aria-labelledby="generation-sampling-title">
			<h3 id="generation-sampling-title">Sampling</h3>
			<p>Optional values sent with every request. An empty field uses the provider default.</p>
			{SAMPLING_FIELDS.map((field) => {
				const parsed = parseSamplingDraft(drafts[field]);
				return (
					<div className="field" key={field}>
						<label htmlFor={`generation-${field}`}>{SAMPLING_FIELD_LABELS[field]}</label>
						<input
							id={`generation-${field}`}
							className="field-input"
							inputMode="decimal"
							autoComplete="off"
							placeholder="Provider default"
							value={drafts[field]}
							onChange={(event) => onChange(field, event.target.value)}
						/>
						{parsed.status === "invalid" && (
							<small className="field-error" role="alert">{SAMPLING_DRAFT_ERROR}</small>
						)}
					</div>
				);
			})}
		</section>
	);
}

export function BudgetEditor({
	drafts,
	onChange,
}: {
	drafts: GenerationSettingsDraftController["budgetDrafts"];
	onChange: GenerationSettingsDraftController["updateBudget"];
}) {
	return (
		<section aria-labelledby="generation-budget-title">
			<h3 id="generation-budget-title">Budget</h3>
			<p>Limits applied to the next Generation and its Swipes.</p>
			{BUDGET_FIELDS.map((field) => {
				const parsed = parseBudgetDraft(field, drafts[field]);
				return (
					<div className="field" key={field}>
						<label htmlFor={`generation-${field}`}>{BUDGET_FIELD_LABELS[field]}</label>
						<input
							id={`generation-${field}`}
							className="field-input"
							inputMode="numeric"
							autoComplete="off"
							value={drafts[field]}
							onChange={(event) => onChange(field, event.target.value)}
						/>
						{parsed.status === "invalid" && (
							<small className="field-error" role="alert">{BUDGET_FIELD_ERROR[field]}</small>
						)}
					</div>
				);
			})}
		</section>
	);
}

export function RequestOverridesEditor({
	drafts,
	onChange,
	transmittingNamespace,
}: {
	drafts: GenerationEditorController["overridesDrafts"];
	onChange: GenerationEditorController["updateOverrides"];
	transmittingNamespace: GenerationEditorController["transmittingNamespace"];
}) {
	return (
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
				const parsed = parseOverridesDraft(drafts[namespace]);
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
								data={drafts[namespace]}
								setData={(value) => onChange(namespace, value)}
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
	);
}
