import { Value } from "@sinclair/typebox/value";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { authoringEvent, authoringInstall, authoringStart, type ScenarioResult } from "../../shared/contract/authoring";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import { ProfileModelPicker, type ProfileModelChoice } from "../ProfileModelPicker";

type Entry = { readonly id: string; readonly kind: "writer" | "agent" | "tool" | "error"; readonly text: string };
type Session = { readonly session: string; readonly candidate: string };

const toolLines = new Map([
	["read_contract", "Read the Box contract"], ["write_descriptor", "Wrote descriptor.json"], ["write_logic", "Wrote logic.js"],
	["write_ui", "Wrote ui.js"], ["write_css", "Wrote ui.css"], ["run_scenario", "Ran a scenario"],
]);

/** The latest scenario's diagnostics, each turn's prompt items, and the folded state. */
function ScenarioResults({ result }: { result: ScenarioResult }) {
	return <section className="create-box-scenario" aria-label="Scenario results">
		<h3>{result.ok ? "Scenario passed" : "Scenario failed"}</h3>
		{result.diagnostics.length > 0 && <ul aria-label="Diagnostics">{result.diagnostics.map((line) => <li key={line} className="is-error">{line}</li>)}</ul>}
		{[...result.turns.map((turn, index) => ({ turn, label: `Turn ${index + 1}` })), ...result.swipes.map((turn, index) => ({ turn, label: `Swipe ${index + 1}` }))].map(({ turn, label }) =>
			<div key={label}>
				<h4>{label}</h4>
				{turn.moves.map((move) => <p key={move} className="create-box-move">{move}</p>)}
				<ul aria-label={`${label} prompt items`}>{turn.items.map((item, index) => <li key={index}>{item.text}</li>)}</ul>
			</div>)}
		{result.ok && <>
			<h4>Folded state</h4>
			<pre aria-label="Folded state">{JSON.stringify(result.state, null, 2) ?? "undefined"}</pre>
			<p className="create-box-note">{result.records.length} records, {result.recordBytes} bytes</p>
		</>}
	</section>;
}

// @approved
//  Creator Mode: the writer picks a coding model, describes a mechanic, and
// an embedded agent writes and checks a sandboxed Box. Each turn streams the
// agent's reply and tool calls; each scenario's results replace the last.
// Install publishes the Box app-wide, after which the Box manager lists it
// to add to this Chat. Closing the panel ends the session and drops its
// candidate.
export function CreateBox({ open, onOpenChange, onInstalled }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onInstalled: () => Promise<void>;
}) {
	const [model, setModel] = useState<ProfileModelChoice | null>(null);
	const [contextWindow, setContextWindow] = useState("128000");
	const [maxOutputTokens, setMaxOutputTokens] = useState("8192");
	const [session, setSession] = useState<Session | null>(null);
	const [entries, setEntries] = useState<readonly Entry[]>([]);
	const [draft, setDraft] = useState("");
	const [running, setRunning] = useState(false);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
	const [scenario, setScenario] = useState<ScenarioResult | null>(null);
	const [installed, setInstalled] = useState<string | null>(null);
	const sequence = useRef(0);
	const add = (kind: Entry["kind"], text: string) => setEntries((current) => [...current, { id: String(sequence.current++), kind, text }]);
	const appendAgent = (delta: string) => setEntries((current) => {
		const last = current.at(-1);
		return last?.kind === "agent" ? [...current.slice(0, -1), { ...last, text: last.text + delta }] : [...current, { id: String(sequence.current++), kind: "agent", text: delta }];
	});

	const close = () => {
		if (session !== null) void api.api.authoring.sessions({ session: session.session }).delete();
		setSession(null);
		setEntries([]);
		setScenario(null);
		setInstalled(null);
		setNotice(null);
		setRunning(false);
		onOpenChange(false);
	};

	const start = async () => {
		if (model === null || model.connectionProfileId === null) return;
		setPending(true);
		setNotice(null);
		try {
			const started = await requestData(api.api.authoring.sessions.post({ profileId: model.connectionProfileId, model: model.modelId, contextWindow: Number(contextWindow), maxOutputTokens: Number(maxOutputTokens) }), authoringStart);
			if (started.outcome === "refused") setNotice({ text: started.reason, error: true });
			else setSession({ session: started.session, candidate: started.candidate });
		} catch (error) {
			setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
		} finally {
			setPending(false);
		}
	};

	const send = async () => {
		const text = draft.trim();
		if (session === null || text === "" || running) return;
		setDraft("");
		add("writer", text);
		setRunning(true);
		try {
			const response = await fetch(`/api/authoring/sessions/${encodeURIComponent(session.session)}/prompts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
			if (!response.ok || response.body === null) throw new Error(response.status === 409 ? "A turn is still running." : `The turn could not start (HTTP ${response.status}).`);
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffered = "";
			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
				buffered += chunk.value;
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines.filter((entry) => entry !== "")) {
					const event: unknown = JSON.parse(line);
					if (!Value.Check(authoringEvent, event)) continue;
					if (event.type === "text") appendAgent(event.delta);
					else if (event.type === "tool-end") add(event.isError ? "error" : "tool", event.isError ? `${event.name} failed: ${event.content}` : toolLines.get(event.name) ?? event.name);
					else if (event.type === "scenario") setScenario(event.result);
					else if (event.type === "end" && event.stopReason !== "end_turn") add("error", event.stopReason === "cancelled" ? "Stopped." : `The turn ended: ${event.error ?? event.stopReason}`);
				}
			}
		} catch (error) {
			add("error", error instanceof Error ? error.message : String(error));
		} finally {
			setRunning(false);
		}
	};

	const install = async () => {
		if (session === null) return;
		setPending(true);
		setNotice(null);
		try {
			const result = await requestData(api.api.authoring.sessions({ session: session.session }).install.post(), authoringInstall);
			if (result.outcome === "refused") setNotice({ text: [result.reason, ...result.diagnostics].join(" "), error: true });
			else {
				await onInstalled();
				setInstalled(result.label);
				setNotice({ text: `${result.label} is installed. Add it to a Chat from the Box manager.`, error: false });
			}
		} catch (error) {
			setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
		} finally {
			setPending(false);
		}
	};

	return <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
		<DialogContent className="create-box sm:max-w-3xl">
			<DialogHeader>
				<DialogTitle>Create a Box</DialogTitle>
				<DialogDescription>{session === null ? "Choose the coding model that writes the Box." : "Describe the mechanic. The agent writes the Box and checks it with scenarios."}</DialogDescription>
			</DialogHeader>
			{session === null
				? <div className="create-box-setup">
					<Field label="Coding model">
						<ProfileModelPicker label="Coding model" selected={model} onSelect={(profile, modelId) => setModel({ connectionProfileId: profile.id, modelId })} emptyLabel="Add a Chat Completions connection in Connections." />
					</Field>
					<Field label="Context window" htmlFor="create-box-context">
						<Input id="create-box-context" inputMode="numeric" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} />
					</Field>
					<Field label="Output limit" htmlFor="create-box-output">
						<Input id="create-box-output" inputMode="numeric" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} />
					</Field>
				</div>
				: <div className="create-box-work">
					<ol className="create-box-transcript" aria-label="Authoring conversation" aria-live="polite">
						{entries.map((entry) => <li key={entry.id} data-kind={entry.kind}>{entry.text}</li>)}
					</ol>
					{scenario !== null && <ScenarioResults result={scenario} />}
					<Textarea aria-label="Message to the coding agent" value={draft} disabled={running} placeholder="An inventory the writer adds items to…"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send(); }} />
				</div>}
			{notice !== null && <p className={notice.error ? "composer-control-note is-error" : "composer-control-note"} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
			<DialogFooter>
				{session === null
					? <Button type="button" disabled={pending || model === null} onClick={() => void start()}>Start</Button>
					: <>
						{running
							? <Button type="button" variant="outline" onClick={() => void api.api.authoring.sessions({ session: session.session }).cancel.post()}>Stop</Button>
							: <Button type="button" variant="outline" disabled={draft.trim() === ""} onClick={() => void send()}>Send</Button>}
						<Button type="button" disabled={running || pending || scenario?.ok !== true || installed !== null} onClick={() => void install()}>Install</Button>
					</>}
			</DialogFooter>
		</DialogContent>
	</Dialog>;
}
