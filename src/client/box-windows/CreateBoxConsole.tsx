import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import { useState, type ReactNode } from "react";
import { authoredContent, readContractInput, scenarioInput, type AuthoringEvent, type AuthoringLogEntry, type ScenarioResult } from "../../shared/contract/authoring";
import { CodeView, type CodeLanguage } from "./CodeView";

type ToolStart = Extract<AuthoringEvent, { type: "tool" }>;
type ToolEnd = Extract<AuthoringEvent, { type: "tool-end" }>;
type File = { readonly name: string; readonly content: string };
/** @approved A tool call in the Console: its input, its result once it ends, and the scenario it ran, for a `run_scenario` that got that far. */
export type ToolEntry = { readonly kind: "tool"; readonly id: string; readonly start: ToolStart; readonly end?: ToolEnd; readonly scenario?: ScenarioResult };
// @approved
//  One Console line, in the order it happened: the writer's message or
// command, the agent's reply, its reasoning, a tool call, a host note or
// error, or the candidate's files as `/files` read them.
export type Entry =
	| { readonly kind: "writer" | "agent" | "note" | "error"; readonly id: string; readonly text: string }
	| { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly truncated: boolean }
	| { readonly kind: "files"; readonly id: string; readonly files: readonly File[] }
	| ToolEntry;

const isTool = (entry: Entry | undefined, id: string): entry is ToolEntry => entry?.kind === "tool" && entry.start.id === id;
const withTool = (entries: readonly Entry[], id: string, change: (entry: ToolEntry) => ToolEntry) => entries.map((entry) => isTool(entry, id) ? change(entry) : entry);

// @approved
//  The Console after one log line, streamed now or replayed from the saved
// log: the writer's message, reply text and reasoning, each running into the
// entry of their kind before them, a tool call, whose end and scenario join
// its start, and a turn that ended other than on its own, with why.
export const withEvent = (entries: readonly Entry[], event: AuthoringLogEntry, id: string): readonly Entry[] => {
	const last = entries.at(-1);
	if (event.type === "prompt") return [...entries, { kind: "writer", id, text: event.text }];
	if (event.type === "end") return event.stopReason === "end_turn" ? entries
		: [...entries, { kind: "error", id, text: event.error ?? (event.stopReason === "cancelled" ? "Stopped." : `The message ended: ${event.stopReason}`) }];
	if (event.type === "text") return last?.kind === "agent"
		? [...entries.slice(0, -1), { ...last, text: last.text + event.delta }]
		: [...entries, { kind: "agent", id, text: event.delta }];
	if (event.type === "reasoning") return last?.kind === "reasoning"
		? [...entries.slice(0, -1), { ...last, text: last.text + event.delta, truncated: last.truncated || event.truncated }]
		: [...entries, { kind: "reasoning", id, text: event.delta, truncated: event.truncated }];
	if (event.type === "tool") return [...entries, { kind: "tool", id, start: event }];
	if (event.type === "tool-end") return withTool(entries, event.id, (entry) => ({ ...entry, end: event }));
	if (event.type === "scenario") return withTool(entries, event.id, (entry) => ({ ...entry, scenario: event.result }));
	return entries;
};

const written = new Map([["write_descriptor", "descriptor.json"], ["write_logic", "logic.js"], ["write_ui", "ui.js"], ["write_css", "ui.css"]]);
const fileContent = authoredContent("");
export const languageOf = (file: string): CodeLanguage => file.endsWith(".js") ? "javascript" : file.endsWith(".json") ? "json" : "text";
const size = (text: string) => {
	const bytes = new TextEncoder().encode(text).byteLength;
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
};
/** @approved Text for a code view, in the language it is highlighted as. */
type Shown = { readonly text: string; readonly language: CodeLanguage };
/** @approved JSON text as an editor shows it, pretty-printed, or as written when it is not JSON, such as a cut-short input. */
const pretty = (text: string): Shown => {
	try { return { text: JSON.stringify(JSON.parse(text), null, 2), language: "json" }; } catch { return { text, language: "text" }; }
};
/** @approved A tool call's input when it arrived whole and passes `schema`, else `undefined`. */
export const inputAs = <Schema extends TSchema>(start: ToolStart, schema: Schema): Static<Schema> | undefined => {
	if (start.truncated) return undefined;
	try {
		const input: unknown = JSON.parse(start.input);
		return Value.Check(schema, input) ? input : undefined;
	} catch { return undefined; }
};

/** @approved A `<details>` whose body is built only once it is opened, so a long session's collapsed lines cost nothing. */
function Disclosure({ summary, className, children }: { summary: ReactNode; className: string; children: () => ReactNode }) {
	const [open, setOpen] = useState(false);
	return <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
		<summary>{summary}</summary>
		{open && children()}
	</details>;
}

const statusText = { running: "running", ok: "done", failed: "failed" } as const;
/** @approved A tool call's one line: its name, what it touched, and how it ended. */
function ToolLine({ start, end }: { start: ToolStart; end: ToolEnd | undefined }) {
	const file = written.get(start.name);
	const content = inputAs(start, fileContent)?.content;
	const scenario = inputAs(start, scenarioInput);
	const read = inputAs(start, readContractInput);
	const detail = file !== undefined ? `${file} ${content === undefined ? "large" : size(content)}`
		: scenario !== undefined ? `${scenario.turns.length} ${scenario.turns.length === 1 ? "turn" : "turns"}${scenario.swipes?.length ? `, ${scenario.swipes.length} ${scenario.swipes.length === 1 ? "swipe" : "swipes"}` : ""}`
		: read !== undefined ? [read.example ?? "contract", read.file].filter((part) => part !== undefined).join(" ") : "";
	const status = end === undefined ? "running" : end.isError ? "failed" : "ok";
	return <>
		<span className="create-box-tool-name">{start.name}</span>
		<span className="create-box-tool-detail">{detail}</span>
		<span className="create-box-tool-status" data-status={status}>{statusText[status]}</span>
	</>;
}

// @approved
//  A tool call as the Console shows it: one line, opened to read the input as
// written and the result the agent read. A `run_scenario` that ran is instead
// a button that puts the run in the Scenario panel.
function Tool({ entry, selected, onSelect }: { entry: ToolEntry; selected: boolean; onSelect: (id: string) => void }) {
	const { start, end } = entry;
	if (entry.scenario !== undefined) return <button type="button" className="create-box-tool is-run" aria-pressed={selected} onClick={() => onSelect(start.id)}>
		<ToolLine start={start} end={end} />
	</button>;
	const file = written.get(start.name);
	const content = inputAs(start, fileContent)?.content;
	const shownInput: Shown = file !== undefined && content !== undefined ? { text: content, language: languageOf(file) } : pretty(start.input);
	return <Disclosure className="create-box-tool" summary={<ToolLine start={start} end={end} />}>{() => <div className="create-box-tool-body">
		<h4>Input{start.truncated ? " (cut short)" : ""}</h4>
		<CodeView {...shownInput} label={file !== undefined ? `${file} as written` : `${start.name} input`} />
		<h4>Result{end?.truncated === true ? " (cut short)" : ""}</h4>
		{end === undefined ? <p>Running…</p> : <CodeView {...pretty(end.content)} label={`${start.name} result`} />}
	</div>}</Disclosure>;
}

/** @approved The session's lines, oldest first; each `run_scenario` that ran selects its run. */
export function Console({ entries, selected, onSelect }: { entries: readonly Entry[]; selected: string | null; onSelect: (id: string) => void }) {
	return <ol className="create-box-log" aria-label="Authoring conversation" aria-live="polite">
		{entries.map((entry) => <li key={entry.id} data-kind={entry.kind}>
			{entry.kind === "tool" ? <Tool entry={entry} selected={entry.start.id === selected} onSelect={onSelect} />
				: entry.kind === "reasoning" ? <details className="create-box-reasoning"><summary>{entry.text}{entry.truncated ? " (cut short)" : ""}</summary></details>
				: entry.kind === "files" ? <ul aria-label="Files">{entry.files.length === 0 ? <li>No files yet.</li> : entry.files.map(({ name, content }) => <li key={name}>
					<Disclosure className="create-box-tool" summary={<><span className="create-box-tool-name">{name}</span><span className="create-box-tool-detail">{size(content)}</span></>}>
						{() => <CodeView text={content} language={languageOf(name)} label={name} />}
					</Disclosure>
				</li>)}</ul>
				: entry.text}
		</li>)}
	</ol>;
}
