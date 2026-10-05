import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { AppSelect } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { ConversationSummary } from "../conversation";
import { getLorebookAttachmentState } from "../lorebook-library";
import { OVERRIDES_NAMESPACE_LABELS, requestOverridesSummary } from "../generation-settings-draft";
import { BudgetEditor, SamplingEditor, SiblingGenerationEditor } from "./GenerationSettingsEditors";
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
	return <GenerationSettings conversationId={conversation.id} controller={controller} onOpenInspector={onOpenInspector} />;
}

function GenerationSettings({
	conversationId,
	controller,
	onOpenInspector,
}: {
	conversationId: number;
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
		imagePlacement,
		setImagePlacement,
		updateInstruction,
		canSave,
		dirty,
		save,
		discard,
		samplingDrafts,
		updateSampling,
		budgetDrafts,
		updateBudget,
		overridesDrafts,
	} = controller;
	useSaveGuard({ dirty, saving: status === "saving", save, discard });
	const [loreAllowance, setLoreAllowance] = useState<number | null>(null);
	useEffect(() => {
		let cancelled = false;
		void getLorebookAttachmentState(conversationId).then((state) => { if (!cancelled) setLoreAllowance(state?.allowance ?? null); }).catch(() => undefined);
		return () => { cancelled = true; };
	}, [conversationId]);

	const namespace = transmittingNamespace.status === "known" ? transmittingNamespace.namespace : null;

	return (
		<><div className="panel-body settings-panel-body">
			{settings !== null && problem !== null && (
				<p className="import-problem" role="alert">{problem}</p>
			)}
			{status === "load-error" && (
				<p className="import-problem" role="alert">Generation Settings could not be loaded.</p>
			)}
			{settings !== null && status !== "load-error" && (
				<div className="grid gap-8">
					<p className="flex flex-col gap-0.5 text-xs text-muted-foreground">
						<span className="text-sm font-semibold text-foreground">{settings.modelId}{namespace !== null && <span className="font-normal text-muted-foreground"> · {OVERRIDES_NAMESPACE_LABELS[namespace]}</span>}</span>
						Change the model from the composer.
					</p>

					<SamplingEditor drafts={samplingDrafts} onChange={updateSampling} />

					<BudgetEditor drafts={budgetDrafts} onChange={updateBudget} loreAllowance={loreAllowance} />

					<section aria-labelledby="continuation-settings-title">
						<h3 id="continuation-settings-title">Continuation</h3>
						<p>How the next model Message continues after a length limit.</p>
						<SegmentedControl value={strategy} onValueChange={setStrategy} label="Continuation strategy" options={[{ value: "instruction", label: "Instruction" }, { value: "assistant-prefill", label: "Assistant prefill" }]} />
						{strategy === "assistant-prefill" ? (
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
						) : (
							<Field htmlFor="continuation-instruction" label="Continuation instruction">
								<textarea
									id="continuation-instruction"
									value={instruction}
									rows={3}
									onChange={(event) => updateInstruction(event.target.value)}
								/>
							</Field>
						)}
					</section>

					<section aria-labelledby="image-placement-title">
						<h3 id="image-placement-title">Repeated Images</h3>
						<p>When the same Image appears more than once in a Generation, which copy is sent. The others send only their name.</p>
						<SegmentedControl value={imagePlacement} onValueChange={setImagePlacement} label="Repeated Image placement" options={[{ value: "first", label: "First" }, { value: "last", label: "Last" }, { value: "every", label: "Every" }]} />
						<ul className="grid gap-1 text-xs text-muted-foreground">
							<li><strong>First</strong> keeps the start of the prompt unchanged between Generations, so provider prompt caching keeps working.</li>
							<li><strong>Last</strong> shows the model the Image at its most recent mention, but changes the prompt from the earlier position onward and discards that cache.</li>
							<li><strong>Every</strong> sends and pays for every copy.</li>
						</ul>
					</section>

					<SiblingGenerationEditor draft={budgetDrafts.siblingGenerationLimit} onChange={(value) => updateBudget("siblingGenerationLimit", value)} />

					<button type="button" className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-left hover:bg-muted/50" onClick={onOpenInspector}>
						<span className="grid gap-0.5">
							<span className="text-[0.86rem] font-semibold">Request Overrides</span>
							<span className="text-xs text-muted-foreground">{requestOverridesSummary(overridesDrafts, namespace)}</span>
						</span>
						<ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
					</button>
				</div>
			)}
		</div><SaveFooter dirty={dirty} saving={status === "saving"} valid={canSave} error={problem} onSave={() => void save()} /></>
	);
}
