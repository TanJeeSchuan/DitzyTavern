import { useState } from "react";
import {
	loadActiveGenerationDetails,
	loadVariantDetails,
	type ActiveGenerationDetails,
	type GenerationInspectionStatus,
	type GenerationProvenance,
	type VariantDetails,
} from "./conversation";
import {
	generationJsonObject,
	generationJsonString,
} from "../shared/generation-provenance";
import type { GenerationJsonValue } from "../shared/generation-json";
import { useAsyncEffect } from "./lib/use-async";
import { PanelHeader } from "./PanelHeader";

export type GenerationDetailsTarget =
	| { type: "active"; conversationId: number; generationId: number }
	| { type: "variant"; conversationId: number; messageId: number; variantId: number };

export function GenerationDetailsPanel({
	target,
	onClose,
}: {
	target: GenerationDetailsTarget;
	onClose: () => void;
}) {
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "error"; message: string }
		| { status: "inspection"; details: ActiveGenerationDetails }
		| { status: "variant"; details: VariantDetails }
	>({ status: "loading" });

	useAsyncEffect((isCancelled) => {
		setState({ status: "loading" });
		const showError = (status: "not-found" | "network") => {
			if (isCancelled()) return;
			setState({
				status: "error",
				message: status === "not-found"
					? "These Generation details are no longer available."
					: "Generation details could not be loaded.",
			});
		};
		if (target.type === "active") {
			void loadActiveGenerationDetails(target.conversationId, target.generationId).then((outcome) => {
				if (isCancelled()) return;
				if (outcome.status === "available") {
					setState({ status: "inspection", details: outcome.details });
					return;
				}
				showError(outcome.status);
			});
		} else {
			void loadVariantDetails(target.conversationId, target.messageId, target.variantId).then((outcome) => {
				if (isCancelled()) return;
				if (outcome.status === "available") {
					setState({ status: "variant", details: outcome.details });
					return;
				}
				showError(outcome.status);
			});
		}
	}, [target]);

	return (
		<aside className="details-panel generation-details-panel" data-open="true" aria-label="Generation details">
			<PanelHeader
				title={target.type === "active" ? "Generation inspection" : "Generation details"}
				onClose={onClose}
			/>
			<div className="panel-body generation-details-body">
				{state.status === "loading" && <p className="panel-note" role="status">Loading Generation details…</p>}
				{state.status === "error" && <p className="import-problem" role="alert">{state.message}</p>}
				{state.status === "inspection" && <GenerationInspectionDetails details={state.details} />}
				{state.status === "variant" && <VariantDetailsView details={state.details} />}
			</div>
		</aside>
	);
}

function GenerationInspectionDetails({ details }: { details: ActiveGenerationDetails }) {
	const intent = intentLabel(details.intent);
	const omitted = Array.isArray(details.budget.omittedHistory) ? details.budget.omittedHistory : [];
	return (
		<>
			<p className="generation-detail-status" role="status">{inspectionStatusLabel(details.status)} · Generation {details.generationId}</p>
			<dl className="detail-list">
				<div><dt>Target</dt><dd>Message {details.messageId} · Variant {details.variantId}</dd></div>
				<div><dt>Intent</dt><dd>{intent}</dd></div>
				<div><dt>Writing as</dt><dd>{details.participants.human.name}</dd></div>
				<div><dt>Responding as</dt><dd>{details.participants.model.name}</dd></div>
				<div><dt>Token estimate</dt><dd>{details.budget.tokenEstimate ?? "Unavailable"}</dd></div>
				<div><dt>Response budget</dt><dd>{details.budget.responseBudget ?? "Unavailable"}</dd></div>
				<div><dt>Safety allowance</dt><dd>{details.budget.safetyAllowance ?? "Unavailable"}</dd></div>
				<div><dt>Context limit</dt><dd>{details.budget.contextLimit ?? "Unavailable"}</dd></div>
			</dl>
			{omitted.length > 0 && (
				<section className="generation-detail-section">
					<h3>Omitted history</h3>
					<ul>
						{omitted.map((entry, index) => {
							const item = generationJsonObject(entry);
							const speakerName = generationJsonString(item?.speakerName);
							const content = generationJsonString(item?.content);
							return <li key={index}>{speakerName === null ? "" : `${speakerName}: `}{content ?? "Message omitted"}</li>;
						})}
					</ul>
				</section>
			)}
			<PromptPlan plan={details.promptPlan} />
		</>
	);
}

function PromptPlan({ plan }: { plan: GenerationJsonValue }) {
	const object = generationJsonObject(plan);
	const blocks = Array.isArray(object?.blocks) ? object.blocks : [];
	return (
		<details className="generation-detail-section generation-prompt-plan" open>
			<summary>Captured Prompt Plan</summary>
			{blocks.length === 0 ? <p className="panel-note">No Prompt Plan blocks are available.</p> : (
				<ol>
					{blocks.map((block, index) => {
						const item = generationJsonObject(block);
						const kind = generationJsonString(item?.kind);
						const content = generationJsonString(item?.content);
						return <li key={index}><span>{kind ?? "block"}</span><p>{content ?? ""}</p></li>;
					})}
				</ol>
			)}
		</details>
	);
}

function VariantDetailsView({ details }: { details: VariantDetails }) {
	const provenance = details.provenance;
	return (
		<>
			<p className="generation-detail-status">Message {details.messageId} · Variant {details.variantId}</p>
			<dl className="detail-list">
				<div><dt>Author</dt><dd>{details.author?.capturedName ?? "Unknown author"}</dd></div>
				{provenance !== null && <>
					<div><dt>Status</dt><dd>{statusLabel(provenance)}</dd></div>
					<div><dt>Model</dt><dd>{provenance.modelId ?? "Unavailable"}</dd></div>
					<div><dt>Connection Profile</dt><dd>{provenance.connectionProfileId ?? "Unavailable"} · revision {provenance.connectionSettingsRevision ?? "Unavailable"}</dd></div>
					<div><dt>Backend</dt><dd>{provenance.modelBackend ?? "Unavailable"}</dd></div>
					<div><dt>Adapter</dt><dd>{provenance.adapter ?? "Unavailable"}</dd></div>
					<div><dt>Finish</dt><dd>{provenance.finishReason ?? "Unavailable"}</dd></div>
					{provenance.interruptionCause !== null && <div><dt>Interruption</dt><dd>{provenance.interruptionCause}</dd></div>}
				</>}
			</dl>
			{provenance !== null && <ProvenanceSettings provenance={provenance} />}
			{provenance === null && <p className="panel-note">This Variant has no Generation provenance.</p>}
		</>
	);
}

function ProvenanceSettings({ provenance }: { provenance: GenerationProvenance }) {
	const settings = provenance.generationSettings;
	return (
		<section className="generation-detail-section">
			<h3>Generation Settings</h3>
			<dl className="detail-list compact-detail-list">
				<div><dt>Temperature</dt><dd>{settings.temperature ?? "Unset"}</dd></div>
				<div><dt>Top P</dt><dd>{settings.topP ?? "Unset"}</dd></div>
				<div><dt>Response budget</dt><dd>{settings.responseBudget ?? "Unavailable"}</dd></div>
				<div><dt>Safety allowance</dt><dd>{settings.safetyAllowance ?? "Unavailable"}</dd></div>
				{provenance.usage !== null && <div><dt>Usage</dt><dd>{formatUsage(provenance.usage)}</dd></div>}
			</dl>
		</section>
	);
}

function intentLabel(intent: GenerationJsonValue): string {
	const value = generationJsonObject(intent);
	const type = generationJsonString(value?.type);
	if (type === "sibling") return "Sibling";
	if (type === "continuation") {
		return generationJsonString(value?.strategy) === "assistant-prefill"
			? "Continuation · Assistant prefill"
			: "Continuation · Instruction";
	}
	return "Tail";
}

function statusLabel(provenance: GenerationProvenance): string {
	if (provenance.status === "length-limited") return "Length-limited";
	if (provenance.status === "interrupted") return "Interrupted";
	return "Complete";
}

function inspectionStatusLabel(status: GenerationInspectionStatus): string {
	if (status === "length-limited") return "Length-limited";
	if (status === "interrupted") return "Interrupted";
	if (status === "complete") return "Complete";
	return "Active";
}

function formatUsage(usage: Record<string, number>): string {
	return Object.entries(usage).map(([key, value]) => `${key}: ${value}`).join(" · ");
}

