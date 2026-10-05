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
import type { PromptImage } from "../shared/contract/conversation-schema";
import { projectImageAnchors } from "../shared/image-reference";
import type { LoreActivationRecord } from "../shared/contract/lore-activation";
import type { MemoryActivationRecord } from "../shared/contract/memory-recall";
import { useAsyncEffect } from "./lib/use-async";
import { PanelHeader } from "./PanelHeader";

export type GenerationDetailsTarget =
	| { type: "active"; conversationId: number; generationId: number }
	| { type: "variant"; conversationId: number; messageId: number; variantId: number };

export function GenerationDetailsPanel({
	target,
	onClose,
	onNavigateSource,
}: {
	target: GenerationDetailsTarget;
	onClose: () => void;
	onNavigateSource?: (messageId: number) => void;
}) {
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "error"; message: string }
		| { status: "inspection"; details: ActiveGenerationDetails }
		| { status: "variant"; details: VariantDetails }
	>({ status: "loading" });

	useAsyncEffect((isCancelled) => {
		setState({ status: "loading" });
		const showError = (status: "not-found" | "invalid" | "network", reason?: string) => {
			if (isCancelled()) return;
			setState({
				status: "error",
				message: status === "not-found"
					? "These Generation details are no longer available."
					: status === "invalid"
						? reason ?? "Stored Generation details are invalid."
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
				showError(outcome.status, outcome.status === "invalid" ? outcome.reason : undefined);
			});
		} else {
			void loadVariantDetails(target.conversationId, target.messageId, target.variantId).then((outcome) => {
				if (isCancelled()) return;
				if (outcome.status === "available") {
					setState({ status: "variant", details: outcome.details });
					return;
				}
				showError(outcome.status, outcome.status === "invalid" ? outcome.reason : undefined);
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
				{state.status === "inspection" && <GenerationInspectionDetails details={state.details} onNavigateSource={onNavigateSource} />}
				{state.status === "variant" && <VariantDetailsView details={state.details} onNavigateSource={onNavigateSource} />}
			</div>
		</aside>
	);
}

function GenerationInspectionDetails({ details, onNavigateSource }: { details: ActiveGenerationDetails; onNavigateSource?: (messageId: number) => void }) {
	const intent = intentLabel(details.intent);
	const omitted = Array.isArray(details.budget.omittedContext) ? details.budget.omittedContext : [];
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
			{details.loreActivation != null && <LoreActivationDetails record={details.loreActivation} />}
			{details.memoryActivation != null && <MemoryActivationDetails record={details.memoryActivation} memorySources={details.memorySources} onNavigateSource={onNavigateSource} />}
			<PromptImageList images={details.promptPlan.images} />
			<PromptPlan plan={details.promptPlan} />
		</>
	);
}

const imageDispositionLabel = (image: PromptImage): string =>
	image.disposition === "send"
		? `Sent${image.tokens > 0 ? ` · ~${image.tokens.toLocaleString()} tokens` : ""}`
		: image.disposition === "text-only"
			? "Name only (text-only model)"
			: image.disposition === "anchor"
				? "Name only (another copy is sent)"
				: "Missing · name only";

export function PromptImageList({ images }: { images: readonly PromptImage[] }) {
	if (images.length === 0) return null;
	const missing = images.filter((image) => image.disposition === "missing");
	return (
		<section className="generation-detail-section">
			<h3>Images</h3>
			{missing.length > 0 && (
				<p className="panel-note" role="alert">
					{missing.length === 1 ? "An Image is missing and sends only its name" : `${missing.length} Images are missing and send only their names`}: {missing.map((image) => image.name).join(", ")}.
				</p>
			)}
			<ul>
				{images.map((image, index) => <li key={`${image.block}-${image.start}-${index}`}>{image.name} · {imageDispositionLabel(image)}</li>)}
			</ul>
		</section>
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
						return <li key={index}><span>{kind ?? "block"}</span><p>{projectImageAnchors(content ?? "")}</p></li>;
					})}
				</ol>
			)}
		</details>
	);
}

function VariantDetailsView({ details, onNavigateSource }: { details: VariantDetails; onNavigateSource?: (messageId: number) => void }) {
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
			{details.loreActivation !== null && <LoreActivationDetails record={details.loreActivation} />}
			{details.memoryActivation !== null && <MemoryActivationDetails record={details.memoryActivation} memorySources={details.memorySources} onNavigateSource={onNavigateSource} />}
			{provenance === null && <p className="panel-note">This Variant has no Generation provenance.</p>}
		</>
	);
}

export function LoreActivationDetails({ record }: { record: LoreActivationRecord }) {
	return (
		<section className="generation-detail-section">
			<h3>Lore activation</h3>
			<dl className="detail-list compact-detail-list">
				<div><dt>Evaluation</dt><dd>{record.mode}</dd></div>
				<div><dt>Manual edit</dt><dd>{record.manuallyEdited ? "Yes" : "No"}</dd></div>
			</dl>
			<details>
				<summary>Automatic activation evidence</summary>
				<p className="generation-detail-preformatted">{record.automaticLoreText || "No Lore text was selected automatically."}</p>
				<pre>{JSON.stringify(record.evidence, null, 2)}</pre>
			</details>
			{record.manuallyEdited && <p className="panel-note">The final Lore text was edited after automatic activation.</p>}
			<details>
				<summary>Final Lore text</summary>
				<p className="generation-detail-preformatted">{record.finalLoreText || "No Lore text was sent."}</p>
			</details>
		</section>
	);
}

const memoryStateLabel = (state: MemoryActivationRecord["state"]): string => ({
	disabled: "Memory block disabled",
	"allowance-zero": "Memory Allowance is zero",
	empty: "No ready Memories",
	rebuilding: "Memory indexes are being built",
	partial: "Some Memory indexes are unavailable",
	ready: "Memory indexes ready",
	"index-failed": "Memory indexing failed",
	"source-failed": "Some Memory sources failed",
	unconfigured: "Embedding settings needed",
}[state]);

const admissionLabel = (record: MemoryActivationRecord["candidates"][number], manuallyEdited: boolean): string => {
	if (record.admission === "admitted") return manuallyEdited ? "Automatic budget admission" : "Included";
	if (record.admission === "not-retained") return "Below relevance minimum";
	if (record.admission === "request-limit") return "Omitted from Jev request";
	if (record.admission === "duplicate-rendering") return "Duplicate rendering";
	if (record.admission === "allowance") return "Over Memory Allowance";
	if (record.admission === "oversized") return "Too large for Memory Allowance";
	return "Does not fit the context limit";
};

export function MemoryActivationDetails({ record, memorySources, onNavigateSource }: {
	record: MemoryActivationRecord;
	memorySources: ActiveGenerationDetails["memorySources"];
	onNavigateSource?: (messageId: number) => void;
}) {
	return (
		<section className="generation-detail-section">
			<h3>Memory recall</h3>
			<dl className="detail-list compact-detail-list">
				<div><dt>Status</dt><dd>{memoryStateLabel(record.state)}</dd></div>
				<div><dt>Eligible sources</dt><dd>{record.eligibleSourceCount}</dd></div>
				<div><dt>Ready claims</dt><dd>{record.readyRecordCount}</dd></div>
				<div><dt>Shortlist</dt><dd>{record.semanticShortlistCount} semantic · {record.recentShortlistCount} recent</dd></div>
				<div><dt>Pending indexes</dt><dd>{record.pendingIndexCount}{record.pendingSourceCount > 0 ? ` · ${record.pendingSourceCount} sources processing` : ""}</dd></div>
				<div><dt>Failed</dt><dd>{record.failedIndexCount} indexes · {record.failedSourceCount} sources</dd></div>
				<div><dt>Memory Allowance</dt><dd>{record.allowance.toLocaleString()} estimated tokens</dd></div>
				<div><dt>Embedding model</dt><dd>{record.embeddingModel || "Not configured"} · {record.embeddingDeadlineMs.toLocaleString()} ms</dd></div>
				<div><dt>Jev model</dt><dd>{record.jevModel}{record.jevConfigured ? " · credential configured" : " · credential missing"}</dd></div>
				<div><dt>Relevance minimum</dt><dd>{record.relevanceMinimum}</dd></div>
				<div><dt>Prompt edit</dt><dd>{record.manuallyEdited ? "Manual" : "Automatic"}</dd></div>
			</dl>
			<p className="panel-note">{record.manuallyEdited ? "This Memory block was edited for this Generation. Saved source Memories are unchanged." : "This Generation used its automatic Memory selection. Saved Memory corrections are managed separately in Memories."}</p>
			{record.readyRecordCount === 0 && record.pendingIndexCount + record.pendingSourceCount > 0 && <p className="panel-note">The empty block reflects unfinished indexing or extraction; it does not mean recall found no relevant claims.</p>}
			{record.manuallyEdited && <details><summary>Automatic Memory selection</summary><pre className="generation-detail-preformatted">{record.automaticMemoryText || "No Memory text was selected automatically."}</pre></details>}
			<details><summary>Final Memory block</summary><pre className="generation-detail-preformatted">{record.finalMemoryText || "The final Memory block was empty."}</pre></details>
			<details>
				<summary>Considered claims ({record.candidates.length})</summary>
				{record.candidates.length === 0 ? <p className="panel-note">No ready claims were considered for this scene.</p> : <ol>
					{record.candidates.map((candidate) => <li key={candidate.identity}>
						<strong>{admissionLabel(candidate, record.manuallyEdited)}</strong>
						<p>{candidate.claim} (Attribution: {candidate.attribution}){candidate.people.length > 0 ? ` · ${candidate.people.join(", ")}` : ""}</p>
						<p className="panel-note"><MemorySourceLink messageId={candidate.messageId} variantId={candidate.variantId} sources={memorySources} onNavigateSource={onNavigateSource} /> · Variant {candidate.variantId} · {candidate.ownership === "writer" ? "writer-maintained" : "automatic"}{candidate.sourceChanged ? " · source changed since this Memory was saved" : ""} · collection {candidate.collectionRevision} · claim {candidate.claimIndex + 1} · {candidate.semanticRank === null ? "no semantic rank" : `semantic #${candidate.semanticRank} (${candidate.semanticSimilarity?.toFixed(3)})`}{candidate.recentRank === null ? "" : ` · recent #${candidate.recentRank}`} · {candidate.relevance === null ? "Not judged" : `Jev relevance ${candidate.relevance} (${candidate.relevanceScore?.toFixed(2)})`}</p>
						{candidate.evidence.length > 0 && <details><summary>Supporting excerpts</summary><ul>{candidate.evidence.map((evidence, index) => <li key={`${evidence.messageId}-${index}`}><MemorySourceLink messageId={evidence.messageId} variantId={null} sources={memorySources} onNavigateSource={onNavigateSource} /><blockquote>{evidence.excerpt}</blockquote></li>)}</ul></details>}
					</li>)}
				</ol>}
			</details>
			{record.candidates.some((candidate) => candidate.relevance !== null) && <p className="panel-note">Jev relevance is a model judgment about this scene, not proof that a Memory claim is true.</p>}
			<details><summary>Captured recall scene</summary><p className="panel-note">Messages {record.scanMessageIds.length ? record.scanMessageIds.map((messageId, index) => <span key={messageId}>{index > 0 ? ", " : ""}<MemorySourceLink messageId={messageId} variantId={null} sources={memorySources} onNavigateSource={onNavigateSource} /></span>) : "none"}{record.scanTruncated ? " · scene text truncated to fit the scan limit" : ""}</p><pre className="generation-detail-preformatted">{record.scene || "No visible scene text was available."}</pre></details>
		</section>
	);
}

function MemorySourceLink({ messageId, variantId, sources, onNavigateSource }: {
	messageId: number;
	variantId: number | null;
	sources: ActiveGenerationDetails["memorySources"];
	onNavigateSource?: (messageId: number) => void;
}) {
	const exists = variantId === null ? sources.messageIds.includes(messageId) : sources.variantIds.includes(variantId);
	return exists && onNavigateSource !== undefined
		? <button type="button" className="memory-source-link" onClick={() => onNavigateSource(messageId)}>Message {messageId}</button>
		: <>Message {messageId}</>;
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
