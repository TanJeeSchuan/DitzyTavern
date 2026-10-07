import { JsonEditor, type JsonData, type Theme } from "json-edit-react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
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
	type OverridesNamespace,
} from "../generation-settings-draft";
import type { GenerationSettingsDraftController } from "./useGenerationSettingsDraft";

const TOKEN_BUDGET_FIELDS = ["contextLimit", "responseBudget", "safetyAllowance"] as const;
const formatTokens = (value: number) => value.toLocaleString();

const SAMPLING_SLIDERS = {
	temperature: { min: 0, max: 2, neutral: 1 },
	topP: { min: 0, max: 1, neutral: 1 },
	frequencyPenalty: { min: -2, max: 2, neutral: 0 },
	presencePenalty: { min: -2, max: 2, neutral: 0 },
} as const satisfies Record<(typeof SAMPLING_FIELDS)[number], { min: number; max: number; neutral: number }>;

export function SamplingEditor({
	drafts,
	onChange,
}: {
	drafts: GenerationSettingsDraftController["samplingDrafts"];
	onChange: GenerationSettingsDraftController["updateSampling"];
}) {
	return (
		<section aria-labelledby="generation-sampling-title">
			<h3 id="generation-sampling-title">Sampling</h3>
			<p>Sent with every request. Cleared values use the provider default.</p>
			<div className="@container grid gap-3">
				{SAMPLING_FIELDS.map((field) => {
					const parsed = parseSamplingDraft(drafts[field]);
					const slider = SAMPLING_SLIDERS[field];
					const label = SAMPLING_FIELD_LABELS[field];
					const set = parsed.status === "valid";
					return (
						<div key={field} className="group/sampling grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 @sm:grid-cols-[8rem_1fr_5.5rem]">
							<label htmlFor={`generation-${field}`} className="text-[13px] font-medium text-muted-foreground">{label}</label>
							<span className="flex items-center justify-end @sm:order-last">
								<input
									id={`generation-${field}`}
									className={`h-7 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-right text-[13px] tabular-nums
										outline-none placeholder:text-muted-foreground hover:border-border focus-visible:border-ring
										focus-visible:ring-3 focus-visible:ring-ring/30 ${
											set || parsed.status === "invalid" ? "w-14" : "w-20"
										}`}
									inputMode="decimal"
									autoComplete="off"
									placeholder="Default"
									value={drafts[field]}
									onChange={(event) => onChange(field, event.target.value)}
								/>
								{parsed.status !== "empty" && (
										<Button
											type="button"
											size="icon-xs"
											variant="ghost"
											className="text-muted-foreground"
											title="Use provider default"
											aria-label={`Use provider default for ${label}`}
											onClick={() => onChange(field, "")}
										>
											<X aria-hidden="true" />
										</Button>
									)}
							</span>
							{parsed.status === "empty" ? (
								<Button
										type="button"
										size="sm"
										variant="outline"
										className="col-span-2 justify-self-start @sm:col-span-1"
										aria-label={`Set ${label}`}
										onClick={() => onChange(field, String(slider.neutral))}
									>
										Set
									</Button>
							) : (
								<Slider
									className="col-span-2 py-1.5 @sm:col-span-1 [&_[data-slot=slider-track]]:bg-foreground/15"
									min={slider.min}
									max={slider.max}
									step={0.01}
									value={[set ? Math.min(slider.max, Math.max(slider.min, parsed.value)) : slider.neutral]}
									onValueChange={([value]) => { if (value !== undefined) onChange(field, String(Math.round(value * 100) / 100)); }}
									aria-label={label}
								/>
							)}
							{parsed.status === "invalid" && <small className="field-error col-span-full text-xs" role="alert">{SAMPLING_DRAFT_ERROR}</small>}
						</div>
					);
				})}
			</div>
		</section>
	);
}

export function BudgetEditor({
	drafts,
	onChange,
	loreAllowance,
}: {
	drafts: GenerationSettingsDraftController["budgetDrafts"];
	onChange: GenerationSettingsDraftController["updateBudget"];
	loreAllowance: number | null;
}) {
	const [context, response, safety] = TOKEN_BUDGET_FIELDS.map((field) => parseBudgetDraft(field, drafts[field]));
	return (
		<section aria-labelledby="generation-budget-title">
			<h3 id="generation-budget-title">Budget</h3>
			<p>Token limits for the next Generation and its Swipes.</p>
			<div className="grid gap-2">
				{TOKEN_BUDGET_FIELDS.map((field) => (
					<div key={field} className="grid gap-1">
						<div className="flex items-center justify-between gap-3">
							<label htmlFor={`generation-${field}`} className="whitespace-nowrap text-[13px] font-medium text-muted-foreground">{BUDGET_FIELD_LABELS[field]}</label>
							<span className="flex items-center gap-2 text-xs text-muted-foreground">
								<span className="w-24">
									<input
										id={`generation-${field}`}
										className="field-input text-right tabular-nums"
										inputMode="numeric"
										autoComplete="off"
										value={drafts[field]}
										onChange={(event) => onChange(field, event.target.value)}
									/>
								</span>
								tokens
							</span>
						</div>
						{parseBudgetDraft(field, drafts[field]).status === "invalid" && <small className="field-error text-xs" role="alert">{BUDGET_FIELD_ERROR[field]}</small>}
					</div>
				))}
			</div>
			{context?.status === "valid" && response?.status === "valid" && safety?.status === "valid" && <BudgetBar
				contextLimit={context.value}
				responseBudget={response.value}
				safetyAllowance={safety.value}
				loreAllowance={loreAllowance}
			/>}
		</section>
	);
}

function BudgetBar({ contextLimit, responseBudget, safetyAllowance, loreAllowance }: { contextLimit: number; responseBudget: number; safetyAllowance: number; loreAllowance: number | null }) {
	const prompt = contextLimit - responseBudget - safetyAllowance;
	if (prompt <= 0) return <p className="mt-3 text-xs text-destructive" role="alert">The Response budget and Safety allowance use the whole Context limit, leaving no room for the prompt.</p>;
	const lore = loreAllowance === null ? 0 : Math.min(loreAllowance, prompt);
	const share = (value: number) => `${(value / contextLimit) * 100}%`;
	return (
		<figure className="mt-4 grid gap-2" aria-label={`Prompt ${formatTokens(prompt)} tokens, Response ${formatTokens(responseBudget)} tokens, Safety ${formatTokens(safetyAllowance)} tokens`}>
			<div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
				<div className="flex bg-foreground/55" style={{ width: share(prompt) }}><div className="bg-primary" style={{ width: `${(lore / prompt) * 100}%` }} /></div>
				<div className="border-l-2 border-background bg-foreground/25" style={{ width: share(responseBudget) }} />
				<div className="border-l-2 border-background bg-foreground/12" style={{ width: share(safetyAllowance) }} />
			</div>
			<figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
				<BudgetKey className="bg-foreground/55" label="Prompt" value={prompt} />
				{lore > 0 && <BudgetKey className="bg-primary" label="Lore, at most" value={lore} />}
				<BudgetKey className="bg-foreground/25" label="Response" value={responseBudget} />
				<BudgetKey className="bg-foreground/12" label="Safety" value={safetyAllowance} />
			</figcaption>
		</figure>
	);
}

function BudgetKey({ className, label, value }: { className: string; label: string; value: number }) {
	return <span className="flex items-center gap-1.5"><span className={`size-2 rounded-full ${className}`} />{label} <span className="tabular-nums text-foreground">{formatTokens(value)}</span></span>;
}

export function SiblingGenerationEditor({
	draft,
	onChange,
}: {
	draft: string;
	onChange: (value: string) => void;
}) {
	return (
		<section aria-labelledby="generation-sibling-title">
			<div className="flex items-center justify-between gap-3">
				<h3 id="generation-sibling-title"><label htmlFor="generation-siblingGenerationLimit">{BUDGET_FIELD_LABELS.siblingGenerationLimit}</label></h3>
				<span className="w-16 shrink-0">
					<input
						id="generation-siblingGenerationLimit"
						className="field-input text-right tabular-nums"
						inputMode="numeric"
						autoComplete="off"
						value={draft}
						onChange={(event) => onChange(event.target.value)}
					/>
				</span>
			</div>
			<p>How many Swipes of one Message can generate at once. Further Swipes are refused until one finishes.</p>
			{parseBudgetDraft("siblingGenerationLimit", draft).status === "invalid" && <small className="field-error text-xs" role="alert">{BUDGET_FIELD_ERROR.siblingGenerationLimit}</small>}
		</section>
	);
}

const overridesEditorTheme: Theme = {
	displayName: "DitzyTavern",
	styles: {
		container: { backgroundColor: "transparent", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", color: "var(--foreground)" },
		collection: {},
		property: "var(--foreground)",
		bracket: { color: "var(--text-muted)", fontWeight: "normal" },
		itemCount: { color: "var(--text-faint)", fontStyle: "italic" },
		string: "var(--accent)",
		number: "var(--toggle-on)",
		boolean: "var(--toggle-on)",
		null: { color: "var(--text-faint)", fontStyle: "italic" },
		input: { color: "var(--foreground)", backgroundColor: "var(--surface-muted)", border: "1px solid var(--border)", borderRadius: "0.4rem" },
		inputHighlight: "var(--accent-soft)",
		error: "var(--destructive)",
		iconCollection: "var(--text-muted)",
		iconEdit: "var(--text-muted)",
		iconDelete: "var(--destructive)",
		iconAdd: "var(--text-muted)",
		iconCopy: "var(--text-muted)",
		iconOk: "var(--toggle-on)",
		iconCancel: "var(--destructive)",
	},
};

export function RequestOverridesEditor({
	drafts,
	onChange,
	transmittingNamespace,
}: {
	drafts: GenerationSettingsDraftController["overridesDrafts"];
	onChange: GenerationSettingsDraftController["updateOverrides"];
	transmittingNamespace: GenerationSettingsDraftController["transmittingNamespace"];
}) {
	const transmitting = transmittingNamespace.status === "known" ? transmittingNamespace.namespace : null;
	const namespace = (key: OverridesNamespace) => (
		<OverridesNamespaceEditor
			key={key}
			namespace={key}
			draft={drafts[key]}
			onChange={(value) => onChange(key, value)}
			transmitting={key === transmitting}
		/>
	);
	return (
		<section aria-labelledby="generation-overrides-title">
			<h3 id="generation-overrides-title" className="sr-only">Request Overrides</h3>
			<p>Extra request body fields for this Chat. Each API Format keeps its own set, and only the one matching the selected Connection Profile is sent.</p>
			{transmittingNamespace.status === "no-active-profile" && (
				<small className="overrides-namespace-status" role="note">
					No model connection is selected, so no overrides are sent.
				</small>
			)}
			{transmitting === null ? OVERRIDES_NAMESPACES.map(namespace) : <>
				{namespace(transmitting)}
				<details className="mt-2">
					<summary className="cursor-pointer py-1 text-xs font-medium text-muted-foreground">Other API Formats ({OVERRIDES_NAMESPACES.length - 1})</summary>
					<div className="mt-2">{OVERRIDES_NAMESPACES.filter((key) => key !== transmitting).map(namespace)}</div>
				</details>
			</>}
		</section>
	);
}

function OverridesNamespaceEditor({ namespace, draft, onChange, transmitting }: { namespace: OverridesNamespace; draft: JsonData; onChange: (value: JsonData) => void; transmitting: boolean }) {
	const parsed = parseOverridesDraft(draft);
	const overrides = parsed.status === "valid" ? parsed.value : {};
	const colliding = collidingSamplingOverrideKeys(overrides);
	const managed = managedOverrideKeys(namespace, overrides);
	return (
		<div className="overrides-namespace">
			<div className="overrides-namespace-heading">
				<h4>{OVERRIDES_NAMESPACE_LABELS[namespace]}</h4>
				<span data-transmitting={transmitting}>{transmitting ? "Sent" : "Not sent"}</span>
			</div>
			<div className="overrides-namespace-editor">
				<JsonEditor
					data={draft}
					setData={onChange}
					rootName=""
					theme={overridesEditorTheme}
					collapse={transmitting ? false : 1}
					restrictDrag
					showStringQuotes={false}
					showIconTooltips
					rootFontSize={13}
					maxWidth="100%"
				/>
			</div>
			{Object.keys(overrides).length === 0 && <small className="overrides-notice">Hover the braces and use + to add a field.</small>}
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
}
