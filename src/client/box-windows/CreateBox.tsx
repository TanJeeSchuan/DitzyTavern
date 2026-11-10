import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { authoringFiles, authoringInstall, authoringLogEntry, authoringSessions, authoringStart, CONTINUE_STEPS } from "../../shared/contract/authoring";
import type { AuthoringLogEntry, AuthoringSteps } from "../../shared/contract/authoring";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import { ProfileModelPicker, type ProfileModelChoice } from "../ProfileModelPicker";
import { Console, withEvent, type Entry, type ToolEntry } from "./CreateBoxConsole";
import { Scenario } from "./CreateBoxScenario";
import { errorMessage } from "./registry";

type Session = { readonly session: string; readonly candidate: string };
type Saved = Static<typeof authoringSessions>["sessions"][number];

const stepChoices = { "40": 40, "100": 100, none: null } as const satisfies Record<string, AuthoringSteps>;
type StepChoice = keyof typeof stepChoices;
const isStepChoice = (word: string): word is StepChoice => Object.hasOwn(stepChoices, word);
const stepChoiceOf = (steps: AuthoringSteps): StepChoice => steps === null ? "none" : steps === 40 ? "40" : "100";
const commands = [
	{ name: "/install", hint: "Install the Box for every Chat" },
	{ name: "/steps", hint: "Steps per message: 40, 100 or none" },
	{ name: "/files", hint: "Show the Box's files as they stand" },
	{ name: "/stop", hint: "Stop the running message" },
	{ name: "/discard", hint: "Delete this session and its draft" },
] as const;

/** @approved Reads an NDJSON body line by line, passing on each line that is a log line; blank heartbeat lines and anything else are skipped. */
const readLines = async (body: NonNullable<Response["body"]>, each: (entry: AuthoringLogEntry) => void) => {
	const reader = body.pipeThrough(new TextDecoderStream()).getReader();
	let buffered = "";
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		buffered += chunk.value;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines.filter((entry) => entry !== "")) {
			const entry: unknown = JSON.parse(line);
			if (Value.Check(authoringLogEntry, entry)) each(entry);
		}
	}
};

// @approved
//  Creator Mode: the writer picks a coding model, then talks to an embedded
// agent that writes and checks a sandboxed Box. The Console is the session
// as lines, oldest first: the writer's messages and `/` commands, the
// agent's replies, its reasoning and each tool call, opened to read its
// input and result. Each scenario the agent runs is a line that shows the
// run, turn by turn, in the Scenario panel beside it; a new run is shown as
// it arrives. Install publishes the Box app-wide once the latest run passed,
// after which the Box manager lists it to add to a Chat; a revision the agent
// checks again installs as the Box's next version, which Chats already
// holding the Box take only through their own Update. Sessions are saved:
// the start screen lists them to open again, `reopen` picks one, and opening
// replays its log. Closing the panel releases the session and `/discard`
// deletes it; Escape stops a running message instead of closing.
export function CreateBox({ open, onOpenChange, onInstalled, reopen }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onInstalled: (box: string) => Promise<void>;
	reopen?: string;
}) {
	const [model, setModel] = useState<ProfileModelChoice | null>(null);
	const [saved, setSaved] = useState<readonly Saved[]>([]);
	const [chosen, setChosen] = useState<Saved | null>(null);
	const [session, setSession] = useState<Session | null>(null);
	const [entries, setEntries] = useState<readonly Entry[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [running, setRunning] = useState(false);
	const [pending, setPending] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [installed, setInstalled] = useState<{ readonly label: string; readonly run: string | undefined } | null>(null);
	const [steps, setSteps] = useState<StepChoice>("40");
	const [paused, setPaused] = useState<number | null>(null);
	const [resuming, setResuming] = useState(false);
	const sequence = useRef(0);
	const input = useRef<HTMLTextAreaElement>(null);
	const log = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	// @approved
	//  The open session, held where an unmount can reach it: closing the panel
	// unmounts it, which releases the session, and a Start answered after the
	// panel closed releases the session it started at once.
	const live = useRef<{ mounted: boolean; session: string | null }>({ mounted: true, session: null });
	const release = (session: string) => void api.api.authoring.sessions({ session }).close.post();
	useEffect(() => {
		live.current.mounted = true;
		return () => {
			live.current.mounted = false;
			if (live.current.session !== null) release(live.current.session);
			live.current.session = null;
		};
	}, []);
	const choose = (row: Saved | null) => {
		setChosen(row);
		if (row === null) return;
		setModel({ connectionProfileId: row.profileId, modelId: row.model });
		setSteps(stepChoiceOf(row.steps));
	};
	useEffect(() => {
		requestData(api.api.authoring.sessions.get(), authoringSessions).then(({ sessions }) => {
			setSaved(sessions);
			choose(sessions.find(({ session }) => session === reopen) ?? null);
		}, (error: Error) => setStartError(`Saved sessions could not be read: ${error.message}`));
	}, []);
	// @approved
	//  The log follows new lines while the writer is at its end, and stays put
	// once they scroll back.
	useLayoutEffect(() => {
		if (following.current && log.current !== null) log.current.scrollTop = log.current.scrollHeight;
	}, [entries, paused]);
	const add = (kind: "writer" | "agent" | "note" | "error", text: string) => setEntries((current) => [...current, { kind, id: String(sequence.current++), text }]);

	const runs = entries.filter((entry): entry is ToolEntry => entry.kind === "tool" && entry.scenario !== undefined);
	const shownAt = runs.findIndex((run) => run.start.id === selected);
	const shown = runs[shownAt];
	const before = shown === undefined || shown.start.truncated ? undefined
		: runs.slice(0, shownAt).findLast((run) => !run.start.truncated && run.start.input === shown.start.input)?.scenario;
	const installBlocker = running || pending ? "Wait for the message to finish."
		: installed !== null && installed.run === runs.at(-1)?.start.id ? `${installed.label} is installed.`
		: runs.at(-1)?.scenario?.ok !== true ? "Install needs the latest scenario to pass." : undefined;

	// @approved
	//  Starts a new session, or opens the chosen saved one and replays its log
	// into the Console before showing it, with its latest scenario selected.
	const start = async () => {
		if (model === null || model.connectionProfileId === null) return;
		setPending(true);
		setStartError(null);
		try {
			const choice = { profileId: model.connectionProfileId, model: model.modelId, steps: stepChoices[steps] };
			const request = chosen === null ? api.api.authoring.sessions.post(choice) : api.api.authoring.sessions({ session: chosen.session }).open.post(choice);
			const started = await requestData(request, authoringStart);
			if (started.outcome === "refused") return setStartError(started.reason);
			if (!live.current.mounted) return release(started.session);
			live.current.session = started.session;
			if (chosen !== null) {
				const response = await fetch(`/api/authoring/sessions/${encodeURIComponent(started.session)}/log`);
				if (!response.ok || response.body === null) throw new Error(`The session's log could not be read (HTTP ${response.status}).`);
				let replayed: readonly Entry[] = [];
				await readLines(response.body, (entry) => {
					replayed = withEvent(replayed, entry, String(sequence.current++));
					if (entry.type === "scenario") setSelected(entry.id);
				});
				setEntries(replayed);
			}
			setSession({ session: started.session, candidate: started.candidate });
		} catch (error) {
			setStartError(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	const send = async (current: Session, text: string) => {
		setDraft("");
		add("writer", text);
		setRunning(true);
		try {
			const route = `/api/authoring/sessions/${encodeURIComponent(current.session)}/prompts`;
			const response = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
			if (!response.ok || response.body === null) throw new Error(response.status === 409 ? "A message is still running." : `The message could not start (HTTP ${response.status}).`);
			await readLines(response.body, (event) => {
				const id = String(sequence.current++);
				setEntries((entries) => withEvent(entries, event, id));
				if (event.type === "scenario") setSelected(event.id);
				else if (event.type === "paused") setPaused(event.steps);
			});
		} catch (error) {
			add("error", errorMessage(error));
		} finally {
			setRunning(false);
			setPaused(null);
		}
	};
	const stop = (current: Session) => void api.api.authoring.sessions({ session: current.session }).cancel.post();

	// @approved
	//  The pause stays on screen until the server took the writer's answer, so
	// a Continue or Stop that fails leaves its controls, with why, to try again.
	const resume = async (current: Session, action: "continue" | "cancel", taken: number) => {
		const routes = api.api.authoring.sessions({ session: current.session });
		setResuming(true);
		try {
			const { error } = await (action === "continue" ? routes.continue.post() : routes.cancel.post());
			if (error !== null) throw new Error(`the server answered ${error.status}`);
			setPaused((shownPause) => shownPause === taken ? null : shownPause);
		} catch (error) {
			add("error", `${action === "continue" ? "Continue" : "Stop"} did not go through: ${errorMessage(error)}. Try again.`);
		} finally {
			setResuming(false);
		}
	};

	const install = async (current: Session) => {
		setPending(true);
		try {
			const result = await requestData(api.api.authoring.sessions({ session: current.session }).install.post(), authoringInstall);
			if (result.outcome === "refused") add("error", [result.reason, ...result.diagnostics].join(" "));
			else {
				await onInstalled(result.id);
				setInstalled({ label: result.label, run: runs.at(-1)?.start.id });
				add("note", `${result.label} is installed. Add it to a Chat from the Box manager.`);
			}
		} catch (error) {
			add("error", errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	// @approved
	//  Steps per message is the session's own setting, changed between
	// messages; a paused message goes on for more steps, or stops, only when
	// the writer says so.
	const command = async (current: Session, line: string) => {
		const [name, argument] = line.split(/\s+/);
		if (name === "/install") return installBlocker === undefined ? install(current) : add("error", installBlocker);
		if (name === "/stop") return running ? stop(current) : add("note", "Nothing is running.");
		if (name === "/discard") {
			const { error } = await api.api.authoring.sessions({ session: current.session }).delete();
			if (error !== null) throw new Error(`the server answered ${error.status}`);
			live.current.session = null;
			return onOpenChange(false);
		}
		if (name === "/steps") {
			if (argument === undefined) return add("note", `Steps per message: ${steps === "none" ? "no limit" : steps}.`);
			if (!isStepChoice(argument)) return add("error", "Steps per message is 40, 100 or none.");
			if (running) return add("error", "Steps change between messages.");
			setSteps(argument);
			await api.api.authoring.sessions({ session: current.session }).steps.put({ steps: stepChoices[argument] });
			return add("note", `Steps per message: ${argument === "none" ? "no limit" : argument}.`);
		}
		if (name === "/files") {
			const { files } = await requestData(api.api.authoring.sessions({ session: current.session }).files.get(), authoringFiles);
			return setEntries((entries) => [...entries, { kind: "files", id: String(sequence.current++), files }]);
		}
		add("error", `No command ${name}. Type / to list them.`);
	};
	const runCommand = async (current: Session, line: string) => {
		try {
			await command(current, line);
		} catch (error) {
			add("error", `${line} did not go through: ${errorMessage(error)}`);
		}
	};
	const submit = (current: Session) => {
		const text = draft.trim();
		if (text === "") return;
		if (text.startsWith("/")) {
			setDraft("");
			add("writer", text);
			void runCommand(current, text);
		} else if (running) add("error", "A message is still running.");
		else void send(current, text);
	};
	const matching = draft.startsWith("/") && !/\s/.test(draft) ? commands.filter(({ name }) => name.startsWith(draft)) : [];

	return <Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="create-box sm:max-w-6xl" onEscapeKeyDown={(event) => {
			if (session === null || !running) return;
			event.preventDefault();
			stop(session);
		}}>
			<DialogHeader className="create-box-head">
				<DialogTitle>Create a Box</DialogTitle>
				<DialogDescription className="sr-only">An agent writes a Box from your description and checks it with scenarios.</DialogDescription>
				{session !== null && <Button type="button" size="sm" disabled={installBlocker !== undefined} title={installBlocker} onClick={() => void install(session)}>Install</Button>}
			</DialogHeader>
			{session === null
				? <>
					{saved.length > 0 && <ul className="create-box-saved" aria-label="Saved sessions">
						{saved.map((row) => <li key={row.session}>
							<button type="button" aria-pressed={chosen?.session === row.session} onClick={() => choose(chosen?.session === row.session ? null : row)}>
								<span>{row.label ?? "Untitled Box"}</span>
								{row.installed && <span className="create-box-quiet">Installed</span>}
							</button>
						</li>)}
					</ul>}
					<Field label="Coding model">
						<ProfileModelPicker label="Coding model" selected={model} emptyLabel="Add a Chat Completions connection in Connections."
							onSelect={(profile, modelId) => setModel({ connectionProfileId: profile.id, modelId })} />
					</Field>
					{startError !== null && <p className="composer-control-note is-error" role="alert">{startError}</p>}
					<DialogFooter><Button type="button" disabled={pending || model === null} onClick={() => void start()}>{chosen === null ? "Start" : "Open"}</Button></DialogFooter>
				</>
				: <div className="create-box-columns">
					<section className="create-box-console" aria-label="Console">
						<div ref={log} className="create-box-scroll" onScroll={({ currentTarget: box }) => { following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24; }}>
							<Console entries={entries} selected={shown?.start.id ?? null} onSelect={setSelected} />
							{paused !== null && <div className="create-box-paused" role="group" aria-label="Paused">
								<span>Paused after {paused} steps.</span>
								<Button type="button" size="xs" disabled={resuming} onClick={() => void resume(session, "continue", paused)}>Continue for {CONTINUE_STEPS} more</Button>
								<Button type="button" size="xs" variant="outline" disabled={resuming} onClick={() => void resume(session, "cancel", paused)}>Stop</Button>
							</div>}
						</div>
						<div className="create-box-prompt">
							{matching.length > 0 && <ul className="create-box-commands" aria-label="Commands">
								{matching.map(({ name, hint }) => <li key={name}>
									<button type="button" onClick={() => { setDraft(`${name} `); input.current?.focus(); }}><span>{name}</span>{hint}</button>
								</li>)}
							</ul>}
							<textarea ref={input} aria-label="Message to the coding agent" value={draft} rows={2} placeholder="Describe the Box or a change · / for commands"
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
									event.preventDefault();
									submit(session);
								}} />
							{running && <Button type="button" size="xs" variant="outline" onClick={() => stop(session)}>Stop</Button>}
						</div>
					</section>
					<Scenario run={shown} before={before} />
				</div>}
		</DialogContent>
	</Dialog>;
}
