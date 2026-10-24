import { Button } from "@/box-sdk/client";
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ConversationMemories } from "./contract";
import { memorySourceState } from "./client-source-state";

type Source = ConversationMemories["sources"][number];
const severity = ["failed", "remembered", "unprocessed", "empty", "skipped"] as const;

export function MemoryCoverage({ path, sources, catchup, enabled, busy, selected, label, onStart, onCancel, onSelect }: {
	path: ConversationMemories["path"];
	sources: Map<number, Source>;
	catchup: ConversationMemories["catchUp"];
	enabled: boolean;
	busy: boolean;
	selected: number | null;
	label: (messageId: number) => string;
	onStart: () => void;
	onCancel: () => void;
	onSelect: (messageId: number) => void;
}) {
	const [active, setActive] = useState<number | null>(null);
	const [cursorState, setCursor] = useState(path.length - 1);
	const cursor = Math.min(cursorState, path.length - 1);
	const marks = path.map((entry) => ({ messageId: entry.messageId, source: sources.get(entry.messageId), mark: memorySourceState(sources.get(entry.messageId)) }));
	const memoryCount = marks.reduce((total, { source }) => total + (source?.claims?.length ?? 0), 0);
	const rememberedCount = marks.filter(({ mark }) => mark.kind === "remembered").length;
	const unprocessedCount = marks.filter(({ mark }) => mark.kind === "unprocessed").length;
	const historyFailureCount = marks.filter(({ mark }) => mark.needsAttention).length;
	const bucketCount = Math.min(marks.length, 120);
	const buckets = Array.from({ length: bucketCount }, (_, bucket) => {
		const members = marks.slice(Math.floor(bucket * marks.length / bucketCount), Math.floor((bucket + 1) * marks.length / bucketCount));
		return { kind: severity.find((kind) => members.some(({ mark }) => mark.kind === kind))!, claims: members.reduce((total, { source }) => total + (source?.claims?.length ?? 0), 0) };
	});
	const densest = Math.max(1, ...buckets.map(({ claims }) => claims));
	const at = (event: MouseEvent<HTMLDivElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		return Math.min(
			marks.length - 1,
			Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * marks.length)),
		);
	};
	const step = Math.max(1, Math.round(marks.length / 20));
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(marks[cursor]!.messageId); return; }
		const next = { ArrowRight: cursor + 1, ArrowLeft: cursor - 1, PageUp: cursor - step, PageDown: cursor + step, Home: 0, End: marks.length - 1 }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setCursor(Math.min(marks.length - 1, Math.max(0, next)));
		setActive(Math.min(marks.length - 1, Math.max(0, next)));
	};
	const selectedIndex = marks.findIndex(({ messageId }) => messageId === selected);
	const pin = (index: number) => ({ left: `${(index + 0.5) / marks.length * 100}%` });
	const caption = active !== null && marks[active]
		? `${label(marks[active].messageId)} · ${marks[active].mark.text}`
		: catchup !== null
			? `Remembering history: ${catchup.total - catchup.remaining} of ${catchup.total}${catchup.failed ? ` · ${catchup.failed} failed` : ""}`
			: historyFailureCount > 0
				? `${historyFailureCount} ${historyFailureCount === 1 ? "Message needs" : "Messages need"} another attempt`
				: unprocessedCount > 0
					? `${unprocessedCount} ${unprocessedCount === 1 ? "Message" : "Messages"} not remembered yet`
					: "Every Message has been processed";
	return <section className="memory-coverage" aria-label="Story coverage">
		<p className="memory-coverage-summary">
			<strong>{memoryCount} {memoryCount === 1 ? "Memory" : "Memories"}</strong> from {rememberedCount} of {path.length} {path.length === 1 ? "Message" : "Messages"}
		</p>
		<div
			className="memory-coverage-strip"
			role="slider"
			tabIndex={0}
			aria-label="Messages by Memory state"
			aria-valuemin={1}
			aria-valuemax={marks.length}
			aria-valuenow={cursor + 1}
			aria-valuetext={marks[cursor] && `${label(marks[cursor].messageId)}: ${marks[cursor].mark.text}`}
			onKeyDown={onKeyDown}
			onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setActive(cursor); }}
			onBlur={() => setActive(null)}
			onPointerMove={(event) => setActive(at(event))}
			onPointerLeave={() => setActive(null)}
			onClick={(event) => { const index = at(event); setCursor(index); setActive(index); onSelect(marks[index]!.messageId); }}
		>
			{buckets.map(({ kind, claims }, index) => (
				<span
					key={index}
					className="memory-bucket"
					data-kind={kind}
					style={kind === "remembered" ? { height: `calc(0.3rem + ${claims / densest} * 0.55rem)` } : undefined}
				/>
			))}
			{selectedIndex >= 0 && <span className="memory-pin" data-selected="true" style={pin(selectedIndex)} />}
			{active !== null && <span className="memory-pin" style={pin(active)} />}
		</div>
		<div className="memory-coverage-caption">
			<p>{caption}</p>
			{catchup !== null
				? <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
				: (historyFailureCount > 0 || unprocessedCount > 0) && (
					<Button
						type="button"
						size="xs"
						variant="outline"
						disabled={busy || !enabled}
						onClick={onStart}
					>
						{historyFailureCount > 0 ? "Retry history" : "Remember history"}
					</Button>
				)}
		</div>
	</section>;
}
