import { RefreshCw, Send, X } from "lucide-react";
import type { GenerationPreview } from "./conversation";
import type { PromptPlan } from "../shared/contract/conversation-schema";
import { PanelHeader } from "./PanelHeader";
import { isAssemblyPending, type AssemblySession } from "./assembly-session";
import { LoreActivationDetails } from "./GenerationDetailsPanel";

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
	onClose,
}: {
	assembly: AssemblySession;
	onPlanChange: (plan: PromptPlan) => void;
	onRefresh: () => void;
	onSend: () => void;
	onClose: () => void;
}) {
	const preview = assembly.preview;
	const pending = isAssemblyPending(assembly);
	const editable = preview !== null && !pending;
	const canSend = preview !== null && (assembly.phase === "ready" || assembly.phase === "failed");
	return (
		<aside className="details-panel prompt-plan-preview-panel" data-open="true" aria-label="Prompt Plan preview">
			<PanelHeader title="Prompt Plan preview" onClose={onClose} />
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
				{preview !== null && <section className="generation-detail-section prompt-plan-edit-list">
					<h3>Expanded blocks</h3>
					{preview.promptPlan.blocks.length === 0 && <p className="panel-note">No Prompt Plan blocks are available.</p>}
					{preview.promptPlan.blocks.map((block, index) => (
						<label key={index}>
							<span>{block.kind}{block.role === null || block.role === undefined ? "" : ` · ${block.role}`}</span>
							<textarea
								value={block.content}
								disabled={!editable}
								onChange={(event) => onPlanChange(updateBlock(preview.promptPlan, index, event.target.value))}
								rows={Math.min(12, Math.max(2, block.content.split("\n").length))}
							/>
						</label>
					))}
				</section>}
				{assembly.error !== null && <p className="import-problem" role="alert">{assembly.error}</p>}
				{preview !== null && !preview.budget.budgetFits && <p className="import-problem" role="alert">This plan exceeds the context limit. Shorten it or refresh.</p>}
				<div className="prompt-plan-preview-actions">
					<button className="secondary-button" type="button" onClick={onClose} disabled={assembly.phase === "accepting"}><X aria-hidden="true" /> Cancel</button>
					<button className="secondary-button" type="button" onClick={onRefresh} disabled={pending}><RefreshCw aria-hidden="true" /> {preview === null ? "Retry" : "Refresh"}</button>
					<button className="primary-button" type="button" onClick={onSend} disabled={!canSend || !preview.budget.budgetFits}><Send aria-hidden="true" /> {assembly.phase === "accepting" ? "Sending…" : "Send exact plan"}</button>
				</div>
			</div>
		</aside>
	);
}

function updateBlock(plan: PromptPlan, index: number, content: string): PromptPlan {
	return {
		...plan,
		blocks: plan.blocks.map((block, blockIndex) => blockIndex === index ? { ...block, content } : block),
	};
}
