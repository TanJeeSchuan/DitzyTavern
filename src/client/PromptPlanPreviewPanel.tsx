import { isSingleUseReference, singleUseReferenceLabels } from "../shared/contract/prompt-preset";
import { RefreshCw, Send, Settings, X } from "lucide-react";
import type { GenerationPreview } from "./conversation";
import type { PromptPlan } from "../shared/contract/conversation-schema";
import { PanelHeader } from "./PanelHeader";
import { isAssemblyPending, type AssemblySession } from "./assembly-session";
import { LoreActivationDetails, MemoryActivationDetails, PromptImageList } from "./GenerationDetailsPanel";
import { ProseEditor } from "./editor/ProseEditor";
import { memoryActivationWithFinalText } from "../shared/contract/memory-recall";

const kindLabel = (kind: GenerationPreview["kind"]): string => {
	if (kind === "continuation") return "Continuation";
	if (kind === "sibling") return "Sibling";
	return "New message";
};

export function PromptPlanPreviewPanel({
	assembly,
	onPlanChange,
	onRefresh,
	onSend,
	onNavigateSource,
	onClose,
	onOpenSettings,
}: {
	assembly: AssemblySession;
	onPlanChange: (plan: PromptPlan) => void;
	onRefresh: () => void;
	onSend: () => void;
	onNavigateSource?: (messageId: number) => void;
	onClose: () => void;
	onOpenSettings: () => void;
}) {
	const preview = assembly.preview;
	const pending = isAssemblyPending(assembly);
	const editable = preview !== null && !pending;
	const canSend = preview !== null && (assembly.phase === "ready" || assembly.phase === "failed");
	const memoryActivation = preview?.memoryActivation == null
		? null
		: memoryActivationWithFinalText(
			preview.memoryActivation,
			preview.promptPlan.blocks.find((block) => block.kind === "memory")?.content ?? "",
		);
	return (
		<aside className="details-panel prompt-plan-preview-panel" data-open="true" aria-label="Prompt Plan preview">
			<PanelHeader
				title="Prompt Plan preview"
				onClose={onClose}
				actions={<button className="icon-button" type="button" onClick={onOpenSettings} aria-label="Open Settings"><Settings aria-hidden="true" /></button>}
			/>
			<div className="panel-body generation-details-body">
				{preview === null && pending && <p className="generation-detail-status">Assembling the Prompt Plan…</p>}
				{preview === null && !pending && <p className="generation-detail-status">Prompt Plan assembly failed. Retry or cancel.</p>}
				{preview !== null && <p className="generation-detail-status">{kindLabel(preview.kind)} · edit before sending</p>}
				{preview !== null && <dl className="detail-list compact-detail-list">
					<div><dt>Writing as</dt><dd>{preview.participants.human?.name ?? "Unavailable"}</dd></div>
					<div><dt>Responding as</dt><dd>{preview.participants.model?.name ?? "Unavailable"}</dd></div>
					<div><dt>Prompt estimate</dt><dd>{preview.budget.tokenEstimate.toLocaleString()}</dd></div>
					<div><dt>Required total</dt><dd>{preview.budget.totalRequiredTokens.toLocaleString()} / {preview.budget.contextLimit.toLocaleString()}</dd></div>
				</dl>}
				{preview !== null && preview.promptPlan.warnings.length > 0 && (
					<section className="generation-detail-section">
						<h3>Warnings</h3>
						<ul>
							{preview.promptPlan.warnings.map((warning, index) => <li key={`${warning.block}-${index}`}>{warning.block}: {warning.macro}</li>)}
						</ul>
					</section>
				)}
				{preview !== null && <PromptImageList images={preview.promptPlan.images} />}
				{preview !== null && preview.pendingWrites.length > 0 && (
					<section className="generation-detail-section">
						<h3>Pending variable writes</h3>
						<ul>
							{preview.pendingWrites.map((write, index) => (
								<li key={`${write.name}-${index}`}>{write.operation} {write.name}{write.value === undefined ? "" : ` = ${String(write.value)}`}</li>
							))}
						</ul>
					</section>
				)}
				{preview?.loreActivation != null && <LoreActivationDetails record={preview.loreActivation} />}
				{preview !== null && memoryActivation !== null && <MemoryActivationDetails record={memoryActivation} memorySources={preview.memorySources} onNavigateSource={onNavigateSource} />}
				{preview !== null && <section className="generation-detail-section prompt-plan-edit-list">
					<h3>Expanded blocks</h3>
					{preview.promptPlan.blocks.length === 0 && <p className="panel-note">No Prompt Plan blocks are available.</p>}
					{groupHistoryRuns(preview.promptPlan.blocks).map((run) => {
						const fields = run.map(({ block, index }) => (
							<div key={index} className="prompt-plan-block">
								<span>{isSingleUseReference(block.kind) ? singleUseReferenceLabels[block.kind] : block.kind}{block.role === null || block.role === undefined ? "" : ` · ${block.role}`}</span>
								<ProseEditor
									className="prose-editor-field"
									ariaLabel={`${block.kind} block ${index + 1}`}
									value={block.content}
									disabled={!editable}
									onChange={(content) => onPlanChange(updateBlock(preview.promptPlan, index, content))}
								/>
							</div>
						));
						return run[0].block.kind === "history"
							? <details key={run[0].index} className="prompt-plan-history"><summary>History · {run.length} {run.length === 1 ? "message" : "messages"}</summary>{fields}</details>
							: fields[0];
					})}
				</section>}
			{assembly.error !== null && <p className="import-problem" role="alert">{assembly.error}</p>}
			{preview !== null && !preview.budget.budgetFits && <p className="import-problem" role="alert">This plan exceeds the context limit. Shorten it or refresh.</p>}
			</div>
			<footer className="panel-action-footer prompt-plan-preview-actions">
					<button className="secondary-button" type="button" onClick={onClose} disabled={assembly.phase === "accepting"}><X aria-hidden="true" /> Cancel</button>
					<button className="secondary-button" type="button" onClick={onRefresh} disabled={pending}><RefreshCw aria-hidden="true" /> {preview === null ? "Retry" : "Refresh"}</button>
					<button
						className="primary-button"
						type="button"
						onClick={onSend}
						disabled={!canSend || !preview.budget.budgetFits}
					>
						<Send aria-hidden="true" /> {assembly.phase === "accepting" ? "Sending…" : "Send exact plan"}
					</button>
			</footer>
		</aside>
	);
}

// @approved
// Consecutive history blocks share one run; every other block is its own run.
function groupHistoryRuns(blocks: PromptPlan["blocks"]) {
	const runs: { block: PromptPlan["blocks"][number]; index: number }[][] = [];
	blocks.forEach((block, index) => {
		const last = runs.at(-1);
		if (block.kind === "history" && last?.[0].block.kind === "history") last.push({ block, index });
		else runs.push([{ block, index }]);
	});
	return runs;
}

function updateBlock(plan: PromptPlan, index: number, content: string): PromptPlan {
	return {
		...plan,
		blocks: plan.blocks.map((block, blockIndex) => blockIndex === index ? { ...block, content } : block),
	};
}
