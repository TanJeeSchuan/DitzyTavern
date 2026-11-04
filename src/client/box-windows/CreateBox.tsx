import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { authoringEvent, authoringFiles, authoringInstall, authoringStart, CONTINUE_STEPS, type AuthoringSteps, type ScenarioResult } from "../../shared/contract/authoring";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import { ProfileModelPicker, type ProfileModelChoice } from "../ProfileModelPicker";
import { Activity, FilesStrip, withEvent, type Step } from "./CreateBoxActivity";

type Entry = { readonly id: string; readonly kind: "writer" | "agent" | "error"; readonly text: string };
type Session = { readonly session: string; readonly candidate: string };

const stepChoices = { "40": 40, "100": 100, none: null } as const satisfies Record<string, AuthoringSteps>;
type StepChoice = keyof typeof stepChoices;
const stepOptions = [{ value: "40", label: "40" }, { value: "100", label: "100" }, { value: "none", label: "No limit" }] as const satisfies readonly { value: StepChoice; label: string }[];

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
// agent's reply into the conversation, and each tool call, with its input
// and result, and the agent's reasoning into the Activity beside it, over
// the candidate's files as they stand; each scenario's results replace the
// last.
// Install publishes the Box app-wide, after which the Box manager lists it
// to add to this Chat. Closing the panel ends the session and drops its
// candidate.
export function CreateBox({ open, onOpenChange, onInstalled }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onInstalled: (box: string) => Promise<void>;
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
	const [steps, setSteps] = useState<StepChoice>("40");
	const [paused, setPaused] = useState<number | null>(null);
	const [resuming, setResuming] = useState(false);
	const filesRead = useRef(0);
	const [activity, setActivity] = useState<readonly Step[]>([]);
	const [files, setFiles] = useState<Static<typeof authoringFiles>["files"]>([]);
	const sequence = useRef(0);
	// @approved
	//  The open session, held where an unmount can reach it: closing the panel
	// unmounts it, which ends the session, and a Start answered after the
	// panel closed ends the session it started at once.
	const live = useRef<{ mounted: boolean; session: string | null }>({ mounted: true, session: null });
	const end = (session: string) => void api.api.authoring.sessions({ session }).delete();
	useEffect(() => {
		live.current.mounted = true;
		return () => {
			live.current.mounted = false;
			if (live.current.session !== null) end(live.current.session);
			live.current.session = null;
		};
	}, []);
	const add = (kind: Entry["kind"], text: string) => setEntries((current) => [...current, { id: String(sequence.current++), kind, text }]);
	const appendAgent = (delta: string) => setEntries((current) => {
		const last = current.at(-1);
		return last?.kind === "agent" ? [...current.slice(0, -1), { ...last, text: last.text + delta }] : [...current, { id: String(sequence.current++), kind: "agent", text: delta }];
	});

	const close = () => onOpenChange(false);

	const start = async () => {
		if (model === null || model.connectionProfileId === null) return;
		setPending(true);
		setNotice(null);
		try {
			const started = await requestData(api.api.authoring.sessions.post({ profileId: model.connectionProfileId, model: model.modelId, contextWindow: Number(contextWindow), maxOutputTokens: Number(maxOutputTokens), steps: stepChoices[steps] }), authoringStart);
			if (started.outcome === "refused") setNotice({ text: started.reason, error: true });
			else if (!live.current.mounted) end(started.session);
			else {
				live.current.session = started.session;
				setSession({ session: started.session, candidate: started.candidate });
			}
		} catch (error) {
			setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
		} finally {
			setPending(false);
		}
	};

	// @approved
	//  Each write and each turn's end reads the files again; only the latest
	// read is shown, so an earlier answer arriving last never replaces it.
	const refreshFiles = async (id: string) => {
		const read = ++filesRead.current;
		const answer = await requestData(api.api.authoring.sessions({ session: id }).files.get(), authoringFiles).catch(() => undefined);
		if (answer !== undefined && live.current.mounted && read === filesRead.current) setFiles(answer.files);
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
					const step = String(sequence.current++);
					setActivity((current) => withEvent(current, event, step));
					if (event.type === "text") appendAgent(event.delta);
					else if (event.type === "tool-end" && !event.isError && event.name.startsWith("write_")) void refreshFiles(session.session);
					else if (event.type === "scenario") setScenario(event.result);
					else if (event.type === "paused") setPaused(event.steps);
					else if (event.type === "end" && event.stopReason !== "end_turn") add("error", event.error ?? (event.stopReason === "cancelled" ? "Stopped." : `The turn ended: ${event.stopReason}`));
				}
			}
		} catch (error) {
			add("error", error instanceof Error ? error.message : String(error));
		} finally {
			setRunning(false);
			setPaused(null);
			void refreshFiles(session.session);
		}
	};

	// @approved
	//  Steps per message is the session's own setting, chosen with the model
	// and changed between turns; a paused message goes on for more steps, or
	// stops, only when the writer says so.
	const chooseSteps = (next: StepChoice) => {
		setSteps(next);
		if (session !== null) void api.api.authoring.sessions({ session: session.session }).steps.put({ steps: stepChoices[next] });
	};
	// @approved
	//  The pause stays on screen until the server took the writer's answer, so
	// a Continue or Stop that fails leaves its controls, with why, to try again.
	const resume = async (action: "continue" | "cancel", steps: number) => {
		if (session === null) return;
		const routes = api.api.authoring.sessions({ session: session.session });
		setResuming(true);
		setNotice(null);
		try {
			const { error } = await (action === "continue" ? routes.continue.post() : routes.cancel.post());
			if (error !== null) throw new Error(`the server answered ${error.status}`);
			setPaused((current) => current === steps ? null : current);
		} catch (error) {
			setNotice({ text: `${action === "continue" ? "Continue" : "Stop"} did not go through: ${error instanceof Error ? error.message : String(error)}. Try again.`, error: true });
		} finally {
			setResuming(false);
		}
	};
	const stepsField = <Field label="Steps per message">
		<SegmentedControl label="Steps per message" value={steps} onValueChange={chooseSteps} options={stepOptions} disabled={running} />
	</Field>;

	const install = async () => {
		if (session === null) return;
		setPending(true);
		setNotice(null);
		try {
			const result = await requestData(api.api.authoring.sessions({ session: session.session }).install.post(), authoringInstall);
			if (result.outcome === "refused") setNotice({ text: [result.reason, ...result.diagnostics].join(" "), error: true });
			else {
				await onInstalled(result.id);
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
		<DialogContent className="create-box sm:max-w-5xl">
			<DialogHeader>
				<DialogTitle>Create a Box</DialogTitle>
				<DialogDescription>{session === null ? "Choose the coding model that writes the Box." : "Describe the mechanic. The agent writes the Box and checks it with scenarios."}</DialogDescription>
			</DialogHeader>
			{session === null
				? <div className="create-box-setup">
					<Field label="Coding model">
						<ProfileModelPicker label="Coding model" selected={model} onSelect={(profile, modelId) => setModel({ connectionProfileId: profile.id, modelId })} emptyLabel="Add a Chat Completions connection in Connections." />
					</Field>
					{stepsField}
					<Field label="Context window" htmlFor="create-box-context">
						<Input id="create-box-context" inputMode="numeric" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} />
					</Field>
					<Field label="Output limit" htmlFor="create-box-output">
						<Input id="create-box-output" inputMode="numeric" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} />
					</Field>
				</div>
				: <div className="create-box-columns">
				<div className="create-box-work">
					<ol className="create-box-transcript" aria-label="Authoring conversation" aria-live="polite">
						{entries.map((entry) => <li key={entry.id} data-kind={entry.kind}>{entry.text}</li>)}
					</ol>
					{paused !== null && <div className="create-box-paused" role="group" aria-label="Paused">
						<p>The agent has taken {paused} steps on this message.</p>
						<div className="create-box-paused-actions">
							<Button type="button" size="sm" disabled={resuming} onClick={() => void resume("continue", paused)}>Continue for {CONTINUE_STEPS} more</Button>
							<Button type="button" size="sm" variant="outline" disabled={resuming} onClick={() => void resume("cancel", paused)}>Stop</Button>
						</div>
					</div>}
					{scenario !== null && <ScenarioResults result={scenario} />}
					{stepsField}
					<Textarea aria-label="Message to the coding agent" value={draft} disabled={running} placeholder="An inventory the writer adds items to…"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send(); }} />
				</div>
				<div className="create-box-work">
					<Activity steps={activity} />
					<FilesStrip files={files} />
				</div>
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
