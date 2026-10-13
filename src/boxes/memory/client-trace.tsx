import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";
import { Button, type BoxTrace } from "@/box-sdk/client";
import { memoryActivationRecord, type MemoryActivationRecord, type MemorySources } from "./contract";
import { renderMemoryClaim } from "./shared";
import { loadMemorySources } from "./client-api";

const memoryStateLabel = (state: MemoryActivationRecord["state"]): string => ({
	"allowance-zero": "Memory Allowance is zero",
	empty: "No ready Memories",
	rebuilding: "Messages are still being remembered",
	partial: "Some Messages are not remembered yet",
	ready: "Every Message is remembered",
	"source-failed": "Some Messages could not be remembered",
	unconfigured: "Embedding settings needed",
}[state]);

// @approved
//  A claim recall offered to the prompt was then admitted or refused by the
//  host's budget, which the trace's items record by text.
const admissionLabel = (candidate: MemoryActivationRecord["candidates"][number], trace: BoxTrace, manuallyEdited: boolean): string => {
	if (candidate.admission === "not-retained") return "Below relevance minimum";
	if (candidate.admission === "request-limit") return "Omitted from Decision Model request";
	if (candidate.admission === "duplicate-rendering") return "Duplicate rendering";
	const admission = trace.items.find((item) => item.text === renderMemoryClaim(candidate))?.admission ?? "admitted";
	if (admission === "admitted") return manuallyEdited ? "Automatic budget admission" : "Included";
	if (admission === "allowance") return "Over Memory Allowance";
	if (admission === "oversized") return "Too large for Memory Allowance";
	return "Does not fit the context limit";
};

/** @approved Memory's trace view checks the stored schema and links only to sources still in the Chat. */
export function MemoryActivationDetails({ conversationId, trace, onNavigateSource }: {
	conversationId: number;
	trace: BoxTrace;
	onNavigateSource?: (messageId: number) => void;
}) {
	const record = useMemo(() => trace.trace !== undefined && Value.Check(memoryActivationRecord, trace.trace) ? trace.trace : null, [trace]);
	const cited = useMemo(() => ({
		messageIds: [...new Set([...(record?.scanMessageIds ?? []), ...(record?.candidates.flatMap((candidate) => [candidate.messageId, ...candidate.evidence.map(({ messageId }) => messageId)]) ?? [])])],
		variantIds: [...new Set(record?.candidates.map(({ variantId }) => variantId) ?? [])],
	}), [record]);
	const sources = useQuery({
		queryKey: ["memory", "sources", conversationId, cited],
		queryFn: ({ signal }) => loadMemorySources(conversationId, cited, signal),
		enabled: record !== null,
	});
	const memorySources = sources.isError || sources.data === undefined ? { messageIds: [], variantIds: [] } : sources.data;
	if (record === null) return (
		<section className="generation-detail-section">
			<h3>Memory recall</h3>
			<p className="text-xs text-destructive" role="alert">This Generation's Memory trace no longer matches Memory's schema.</p>
		</section>
	);
	const manuallyEdited = trace.finalText !== trace.automaticText;
	return (
		<section className="generation-detail-section">
			<h3>Memory recall</h3>
			{sources.isError && <div className="grid justify-items-start gap-2">
				<p className="text-xs text-destructive" role="alert">Which sources are still in this Chat could not be checked, so they are not linked.</p>
				<Button type="button" size="sm" variant="outline" onClick={() => void sources.refetch()}>Try again</Button>
			</div>}
			<dl className="detail-list compact-detail-list">
				<div><dt>Status</dt><dd>{memoryStateLabel(record.state)}</dd></div>
				<div><dt>Eligible sources</dt><dd>{record.eligibleSourceCount}</dd></div>
				<div><dt>Ready claims</dt><dd>{record.readyRecordCount}</dd></div>
				<div><dt>Shortlist</dt><dd>{record.semanticShortlistCount} semantic · {record.recentShortlistCount} recent</dd></div>
				<div><dt>Not remembered yet</dt><dd>{record.pendingSourceCount} sources</dd></div>
				<div><dt>Failed</dt><dd>{record.failedSourceCount} sources</dd></div>
				<div><dt>Memory Allowance</dt><dd>{record.allowance.toLocaleString()} estimated tokens</dd></div>
				<div><dt>Embedding model</dt><dd>{record.embeddingModel || "Not configured"} · {record.embeddingDeadlineMs.toLocaleString()} ms</dd></div>
				<div><dt>Decision Model</dt><dd>{record.decisionProfileName ?? "No profile"} · {record.decisionModel || "No model"}{record.decisionConfigured ? " · configured" : " · not configured"}</dd></div>
				<div><dt>Relevance minimum</dt><dd>{record.relevanceMinimum}</dd></div>
				<div><dt>Prompt edit</dt><dd>{manuallyEdited ? "Manual" : "Automatic"}</dd></div>
			</dl>
			<p className="panel-note">
			{manuallyEdited
				? "This Memory block was edited for this Generation. Saved source Memories are unchanged."
				: "This Generation used its automatic Memory selection. Saved Memory corrections are managed separately in Memories."}
		</p>
			{record.readyRecordCount === 0 && record.pendingSourceCount > 0 && (
			<p className="panel-note">The empty block reflects Messages not remembered yet; it does not mean recall found no relevant claims.</p>
		)}
			{manuallyEdited && (
			<details>
				<summary>Automatic Memory selection</summary>
				<pre className="generation-detail-preformatted">{trace.automaticText || "No Memory text was selected automatically."}</pre>
			</details>
		)}
			<details><summary>Final Memory block</summary><pre className="generation-detail-preformatted">{trace.finalText || "The final Memory block was empty."}</pre></details>
			<details>
				<summary>Considered claims ({record.candidates.length})</summary>
				{record.candidates.length === 0 ? <p className="panel-note">No ready claims were considered for this scene.</p> : <ol>
					{record.candidates.map((candidate) => <li key={candidate.identity}>
						<strong>{admissionLabel(candidate, trace, manuallyEdited)}</strong>
						<p>{candidate.claim} (Attribution: {candidate.attribution}){candidate.people.length > 0 ? ` · ${candidate.people.join(", ")}` : ""}</p>
						<p className="panel-note">
							<MemorySourceLink
								messageId={candidate.messageId}
								variantId={candidate.variantId}
								sources={memorySources}
								onNavigateSource={onNavigateSource}
							/> · Variant {candidate.variantId} · {candidate.writer ? "writer-maintained" : "automatic"}
							{candidate.sourceChanged
								? " · source changed since this Memory was saved"
								: ""} · claim {candidate.claimIndex + 1} · {candidate.semanticRank === null
									? "no semantic rank"
									: `semantic #${candidate.semanticRank} (${candidate.semanticSimilarity?.toFixed(3)})`}
							{candidate.recentRank === null ? "" : ` · recent #${candidate.recentRank}`} · {candidate.relevance === null
								? "Not judged"
								: `Decision Model relevance ${candidate.relevance} (${candidate.relevanceScore?.toFixed(2)})`}
						</p>
						{candidate.evidence.length > 0 && (
							<details>
								<summary>Supporting excerpts</summary>
								<ul>
									{candidate.evidence.map((evidence, index) => (
										<li key={`${evidence.messageId}-${index}`}>
											<MemorySourceLink
												messageId={evidence.messageId}
												variantId={null}
												sources={memorySources}
												onNavigateSource={onNavigateSource}
											/>
											<blockquote>{evidence.excerpt}</blockquote>
										</li>
									))}
								</ul>
							</details>
						)}
					</li>)}
				</ol>}
			</details>
			{record.candidates.some((candidate) => candidate.relevance !== null) && (
			<p className="panel-note">Decision Model relevance is a model judgment about this scene, not proof that a Memory claim is true.</p>
		)}
			<details>
			<summary>Captured recall scene</summary>
			<p className="panel-note">
				Messages {record.scanMessageIds.length
					? record.scanMessageIds.map((messageId, index) => (
						<span key={messageId}>
							{index > 0 ? ", " : ""}
							<MemorySourceLink
								messageId={messageId}
								variantId={null}
								sources={memorySources}
								onNavigateSource={onNavigateSource}
							/>
						</span>
					))
					: "none"}
				{record.scanTruncated ? " · scene text truncated to fit the scan limit" : ""}
			</p>
			<pre className="generation-detail-preformatted">{record.scene || "No visible scene text was available."}</pre>
		</details>
		</section>
	);
}

function MemorySourceLink({ messageId, variantId, sources, onNavigateSource }: {
	messageId: number;
	variantId: number | null;
	sources: MemorySources;
	onNavigateSource?: (messageId: number) => void;
}) {
	const exists = variantId === null ? sources.messageIds.includes(messageId) : sources.variantIds.includes(variantId);
	return exists && onNavigateSource !== undefined
		? <button type="button" className="memory-source-link" onClick={() => onNavigateSource(messageId)}>Message {messageId}</button>
		: <>Message {messageId}</>;
}
