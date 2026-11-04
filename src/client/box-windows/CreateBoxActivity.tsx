import { Value } from "@sinclair/typebox/value";
import { useState, type ReactNode } from "react";
import { authoredContent, readContractInput, scenarioInput, type AuthoringEvent } from "../../shared/contract/authoring";
import { CodeView, type CodeLanguage } from "./CodeView";

type ToolStart = Extract<AuthoringEvent, { type: "tool" }>;
type ToolEnd = Extract<AuthoringEvent, { type: "tool-end" }>;
/** @approved One step of the agent's turn: its reasoning, or a tool call with its input and, once it ends, its result. */
export type Step =
	| { readonly kind: "reasoning"; readonly id: string; readonly text: string }
	| { readonly kind: "tool"; readonly id: string; readonly start: ToolStart; readonly end?: ToolEnd };

/** @approved The activity after one streamed event: reasoning runs into the reasoning before it, and a tool call's end joins its start. */
export const withEvent = (steps: readonly Step[], event: AuthoringEvent, id: string): readonly Step[] => {
	const last = steps.at(-1);
	if (event.type === "reasoning") return last?.kind === "reasoning" ? [...steps.slice(0, -1), { ...last, text: last.text + event.delta }] : [...steps, { kind: "reasoning", id, text: event.delta }];
	if (event.type === "tool") return [...steps, { kind: "tool", id, start: event }];
	if (event.type === "tool-end") return steps.map((step) => step.kind === "tool" && step.start.id === event.id ? { ...step, end: event } : step);
	return steps;
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

/** A `<details>` whose body is built only once it is opened, so a long turn's collapsed steps cost nothing. */
function Disclosure({ summary, className, children }: { summary: ReactNode; className: string; children: () => ReactNode }) {
	const [open, setOpen] = useState(false);
	return <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
		<summary>{summary}</summary>
		{open && children()}
	</details>;
}

// @approved
//  A tool call as the panel shows it: its name, what it touched (the file and
// its size, the scenario's turns, the contract or example read) and how it
// ended; opened, the input as written and the result the agent read.
function ToolStep({ start, end }: { start: ToolStart; end: ToolEnd | undefined }) {
	const input: unknown = start.truncated ? undefined : JSON.parse(start.input);
	const file = written.get(start.name);
	const content = Value.Check(fileContent, input) ? input.content : undefined;
	const detail = file !== undefined ? `${file} · ${content === undefined ? "large" : size(content)}`
		: Value.Check(scenarioInput, input) ? `${input.turns.length} ${input.turns.length === 1 ? "turn" : "turns"}${input.swipes?.length ? `, ${input.swipes.length} swipes` : ""}`
		: Value.Check(readContractInput, input) ? input.example ?? "contract" : "";
	const status = end === undefined ? "running" : end.isError ? "failed" : "ok";
	const shownInput: Shown = file !== undefined && content !== undefined ? { text: content, language: languageOf(file) } : pretty(start.input);
	return <Disclosure className="create-box-step" summary={<>
		<span className="create-box-step-name">{start.name}</span>
		<span className="create-box-step-detail">{detail}</span>
		<span className="create-box-step-status" data-status={status}>{status}</span>
	</>}>{() => <div className="create-box-step-body">
		<h4>Input{start.truncated ? " (cut short)" : ""}</h4>
		<CodeView {...shownInput} label={file !== undefined ? `${file} as written` : `${start.name} input`} />
		<h4>Result{end?.truncated === true ? " (cut short)" : ""}</h4>
		{end === undefined ? <p className="create-box-note">Running…</p> : <CodeView {...pretty(end.content)} label={`${start.name} result`} />}
	</div>}</Disclosure>;
}

/** The agent's steps this session, newest last: each tool call, and its reasoning dimmed. */
export function Activity({ steps }: { steps: readonly Step[] }) {
	return <section className="create-box-activity" aria-label="Activity">
		<h3>Activity</h3>
		{steps.length === 0 ? <p className="create-box-note">The agent's tool calls show here.</p> : <ol>
			{steps.map((step) => <li key={step.id}>{step.kind === "tool"
				? <ToolStep start={step.start} end={step.end} />
				: <Disclosure className="create-box-step is-reasoning" summary={<span className="create-box-step-name">Reasoning</span>}>{() => <p className="create-box-reasoning">{step.text}</p>}</Disclosure>}
			</li>)}
		</ol>}
	</section>;
}

/** The candidate's fixed files as they stand now, each opened to read it. */
export function FilesStrip({ files }: { files: readonly { readonly name: string; readonly content: string }[] }) {
	return <section className="create-box-files" aria-label="Files">
		<h3>Files</h3>
		{files.length === 0 ? <p className="create-box-note">No files yet.</p> : <ul>
			{files.map(({ name, content }) => <li key={name}>
				<Disclosure className="create-box-step" summary={<><span className="create-box-step-name">{name}</span><span className="create-box-step-detail">{size(content)}</span></>}>
					{() => <CodeView text={content} language={languageOf(name)} label={name} />}
				</Disclosure>
			</li>)}
		</ul>}
	</section>;
}
