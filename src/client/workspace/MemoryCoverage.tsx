import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationMemories, MemoryCatchup } from "../memories";
import { memorySourceState } from "./memory-source-state";

type Source = ConversationMemories["sources"][number];

export function MemoryCoverage({ path, sources, catchup, enabled, busy, label, onStart, onCancel, onNavigate }: {
	path: ConversationMemories["path"];
	sources: Map<number, Source>;
	catchup: MemoryCatchup | null;
	enabled: boolean;
	busy: boolean;
	label: (messageId: number) => string;
	onStart: () => void;
	onCancel: () => void;
	onNavigate: (messageId: number) => void;
}) {
	const [active, setActive] = useState<number | null>(null);
	const [cursor, setCursor] = useState(0);
	const strip = useRef<HTMLDivElement>(null);
	const marks = path.map((entry) => ({ messageId: entry.messageId, source: sources.get(entry.messageId), mark: memorySourceState(sources.get(entry.messageId)) }));
	const densest = Math.max(1, ...marks.map(({ source }) => source?.claims.length ?? 0));
	const memoryCount = marks.reduce((total, { source }) => total + (source?.claims.length ?? 0), 0);
	const rememberedCount = marks.filter(({ mark }) => mark.kind === "remembered").length;
	const unprocessedCount = marks.filter(({ mark }) => mark.kind === "unprocessed").length;
	const historyFailureCount = marks.filter(({ mark }) => mark.needsAttention).length;
	const indexingCount = marks.reduce((total, { source }) => total + (source && (source.indexing.status === "pending" || source.indexing.status === "running") ? source.indexing.pendingCount : 0), 0);
	const running = catchup?.state === "running" ? catchup : null;
	const focusMark = (index: number) => { setCursor(index); strip.current?.querySelectorAll<HTMLButtonElement>(".memory-mark")[index]?.focus(); };
	const onKeyDown = (event: KeyboardEvent) => {
		const next = { ArrowRight: cursor + 1, ArrowLeft: cursor - 1, Home: 0, End: marks.length - 1 }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		focusMark(Math.min(marks.length - 1, Math.max(0, next)));
	};
	const caption = active !== null && marks[active]
		? `${label(marks[active].messageId)} · ${marks[active].mark.text}`
		: running
			? `Remembering history: ${running.complete} of ${running.pending + running.running + running.complete + running.failed.length}${running.failed.length ? ` · ${running.failed.length} failed` : ""}`
			: historyFailureCount > 0 ? `${historyFailureCount} ${historyFailureCount === 1 ? "Message needs" : "Messages need"} another attempt` : unprocessedCount > 0 ? `${unprocessedCount} ${unprocessedCount === 1 ? "Message" : "Messages"} not remembered yet` : "Every Message has been processed";
	return <section className="memory-coverage" aria-label="Story coverage">
		<p className="memory-coverage-summary"><strong>{memoryCount} {memoryCount === 1 ? "Memory" : "Memories"}</strong> from {rememberedCount} of {path.length} {path.length === 1 ? "Message" : "Messages"}{indexingCount > 0 && ` · ${indexingCount} indexing`}</p>
		<div ref={strip} className="memory-coverage-strip" role="toolbar" aria-label="Messages by Memory state" data-dense={marks.length > 160} onKeyDown={onKeyDown} onMouseLeave={() => setActive(null)}>
			{marks.map(({ messageId, source, mark }, index) => <button
				key={messageId}
				type="button"
				className="memory-mark"
				data-kind={mark.kind}
				tabIndex={index === cursor ? 0 : -1}
				aria-label={`${label(messageId)}: ${mark.text}`}
				onMouseEnter={() => setActive(index)}
				onFocus={() => { setCursor(index); setActive(index); }}
				onBlur={() => setActive(null)}
				onClick={() => onNavigate(messageId)}
			><span style={mark.kind === "remembered" ? { height: `calc(0.3rem + ${(source?.claims.length ?? 0) / densest} * 0.55rem)` } : undefined} /></button>)}
		</div>
		<div className="memory-coverage-caption">
			<p>{caption}</p>
			{running
				? <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
				: (historyFailureCount > 0 || unprocessedCount > 0) && <Button type="button" size="xs" variant="outline" disabled={busy || !enabled} onClick={onStart}>{historyFailureCount > 0 ? "Retry history" : "Remember history"}</Button>}
		</div>
	</section>;
}
