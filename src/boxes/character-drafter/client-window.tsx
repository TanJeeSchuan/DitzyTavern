import { useState } from "react";
import { Button, Field, Input, Textarea, type ConversationSummary } from "@/box-sdk/client";
import { ActivityFeed } from "./client-activity";
import { useDrafterRead, useDraftRun, type DraftRun } from "./client-api";
import { INSTRUCTION_MAX, PERSON_MAX, PERSON_TOO_LONG } from "./contract";

const STEER = "Optional, such as: as she was before the war";

const runLine = (run: DraftRun) => {
	switch (run.status) {
		case "idle": return null;
		case "running": return run.activities.length === 0 ? "Reading the story…" : `Reading the story… ${run.activities.length} ${run.activities.length === 1 ? "step" : "steps"}`;
		case "cancelled": return "Cancelled.";
		case "failed": return run.reason;
		case "drafted": return `Drafted ${run.draft.name}.`;
		case "opened": return `Opened the draft of ${run.name} in the Characters panel.`;
	}
};

/** @approved The writer's line about a run, or why a draft cannot start. */
export function DraftStatus({ run, unavailable }: { run: DraftRun; unavailable: string | null }) {
	const line = runLine(run);
	return <>
		{line !== null && <p className="character-drafter-status" role={run.status === "failed" ? "alert" : "status"} data-status={run.status}>{line}</p>}
		{unavailable !== null && run.status !== "running" && <p className="character-drafter-status" role="status">{unavailable}</p>}
	</>;
}

// @approved
//  The drafter's window: whom to draft, picked from the people Memory knows
// or typed, an optional steer, then the agent's steps as it reads the story
// and, once it submits, the draft to open in the Definition editor.
export function DrafterWindow({ conversation, disabled }: { conversation: ConversationSummary; disabled: boolean }) {
	const { unavailable, people } = useDrafterRead(conversation);
	const { run, start, cancel, open } = useDraftRun({ conversationId: conversation.id });
	const [person, setPerson] = useState("");
	const [instruction, setInstruction] = useState("");
	const running = run.status === "running";
	const locked = disabled || running;
	const draft = () => void start({ conversationId: conversation.id, person: person.trim(), instruction });
	const drafted = run.status === "drafted" ? run.draft : undefined;
	return <div className="character-drafter-window">
		<Field label="Person" htmlFor="character-drafter-person" helper={people.length === 0 ? "Type a name as the story writes it." : undefined}>
			<Input id="character-drafter-person" value={person} placeholder="Name" maxLength={PERSON_MAX} disabled={locked} onChange={(event) => setPerson(event.target.value)} />
		</Field>
		{people.length > 0 && <div className="character-drafter-people" role="group" aria-label="People Memory knows">
			{people.map((label) => <Button key={label} type="button" size="xs" variant="ghost" aria-pressed={person === label} disabled={locked || label.length > PERSON_MAX} onClick={() => setPerson(label)}>
				{label}
			</Button>)}
		</div>}
		{people.some((label) => label.length > PERSON_MAX) && <p className="character-drafter-status">{PERSON_TOO_LONG}</p>}
		<Field label="Instruction" htmlFor="character-drafter-instruction">
			<Textarea
				id="character-drafter-instruction"
				value={instruction}
				rows={2}
				placeholder={STEER}
				maxLength={INSTRUCTION_MAX}
				disabled={locked}
				onChange={(event) => setInstruction(event.target.value)}
			/>
		</Field>
		<div className="character-drafter-actions">
			{running
				? <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
				: <Button type="button" variant={drafted === undefined ? "default" : "outline"} disabled={disabled || unavailable !== null || person.trim() === ""} onClick={draft}>
					{run.status === "idle" ? "Draft" : "Draft again"}
				</Button>}
			{drafted !== undefined && <Button type="button" disabled={disabled} onClick={() => open(drafted)}>Open draft</Button>}
		</div>
		<DraftStatus run={run} unavailable={unavailable} />
		{run.status !== "idle" && <ActivityFeed activities={run.activities} />}
	</div>;
}
