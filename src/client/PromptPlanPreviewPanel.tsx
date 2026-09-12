import { RefreshCw, Send, X } from "lucide-react";
import type { GenerationPreview } from "./conversation";
import type { PromptPlan } from "../shared/contract/conversation-schema";
import { PanelHeader } from "./PanelHeader";

const kindLabel = (kind: GenerationPreview["kind"]): string => {
	if (kind === "continuation") return "Continuation";
	if (kind === "sibling") return "Sibling";
	return "New message";
};

export function PromptPlanPreviewPanel({
	preview,
	pending,
	error,
	onPlanChange,
	onRefresh,
	onSend,
	onClose,
}: {
	preview: GenerationPreview;
	pending: boolean;
	error: string | null;
	onPlanChange: (plan: PromptPlan) => void;
	onRefresh: () => void;
	onSend: () => void;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel prompt-plan-preview-panel" data-open="true" aria-label="Prompt Plan preview">
			<PanelHeader title="Prompt Plan preview" onClose={onClose} />
			<div className="panel-body generation-details-body">
				<p className="generation-detail-status">{kindLabel(preview.kind)} · edit before sending</p>
				<dl className="detail-list compact-detail-list">
					<div><dt>Writing as</dt><dd>{preview.participants.human?.name ?? "Unavailable"}</dd></div>
					<div><dt>Responding as</dt><dd>{preview.participants.model?.name ?? "Unavailable"}</dd></div>
					<div><dt>Prompt estimate</dt><dd>{preview.budget.tokenEstimate.toLocaleString()}</dd></div>
					<div><dt>Required total</dt><dd>{preview.budget.totalRequiredTokens.toLocaleString()} / {preview.budget.contextLimit.toLocaleString()}</dd></div>
				</dl>
				{preview.promptPlan.warnings.length > 0 && (
					<section className="generation-detail-section">
						<h3>Warnings</h3>
						<ul>
							{preview.promptPlan.warnings.map((warning, index) => <li key={`${warning.block}-${index}`}>{warning.block}: {warning.macro}</li>)}
						</ul>
					</section>
				)}
				{preview.pendingWrites.length > 0 && (
					<section className="generation-detail-section">
						<h3>Pending variable writes</h3>
						<ul>
							{preview.pendingWrites.map((write, index) => (
								<li key={`${write.name}-${index}`}>{write.operation} {write.name}{write.value === undefined ? "" : ` = ${String(write.value)}`}</li>
							))}
						</ul>
					</section>
				)}
				<section className="generation-detail-section prompt-plan-edit-list">
					<h3>Expanded blocks</h3>
					{preview.promptPlan.blocks.length === 0 && <p className="panel-note">No Prompt Plan blocks are available.</p>}
					{preview.promptPlan.blocks.map((block, index) => (
						<label key={index}>
							<span>{block.kind}{block.role === null || block.role === undefined ? "" : ` · ${block.role}`}</span>
							<textarea
								value={block.content}
								onChange={(event) => onPlanChange(updateBlock(preview.promptPlan, index, event.target.value))}
								rows={Math.min(12, Math.max(2, block.content.split("\n").length))}
							/>
						</label>
					))}
				</section>
				{error !== null && <p className="import-problem" role="alert">{error}</p>}
				{!preview.budget.budgetFits && <p className="import-problem" role="alert">This plan exceeds the context limit. Shorten it or refresh.</p>}
				<div className="prompt-plan-preview-actions">
					<button className="secondary-button" type="button" onClick={onClose} disabled={pending}><X aria-hidden="true" /> Cancel</button>
					<button className="secondary-button" type="button" onClick={onRefresh} disabled={pending}><RefreshCw aria-hidden="true" /> Refresh</button>
					<button className="primary-button" type="button" onClick={onSend} disabled={pending || !preview.budget.budgetFits}><Send aria-hidden="true" /> {pending ? "Sending…" : "Send exact plan"}</button>
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
