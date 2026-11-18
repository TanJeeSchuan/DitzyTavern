import { useState } from "react";
import { Button, Field, Input, openDefinitionDraft, Textarea, type ConversationSummary } from "@/box-sdk/client";
import { ActivityFeed } from "./client-activity";
import { useDrafterRead, useDraftRun, type DraftRun } from "./client-api";
import descriptor from "./shared-descriptor";

const STEER = "Optional, such as: as she was before the war";

const runLine = (run: DraftRun) => {
	switch (run.status) {
		case "idle": return null;
		case "running": return run.activities.length === 0 ? "Reading the story…" : `Reading the story… ${run.activities.length} ${run.activities.length === 1 ? "step" : "steps"}`;
		case "cancelled": return "Cancelled.";
		case "failed": return run.reason;
		case "drafted": return `Drafted ${run.draft.name}.`;
	}
};

/** @approved The writer's line about a run, or why a draft cannot start. */
export function DraftStatus({ run, unavailable }: { run: DraftRun; unavailable: string | null }) {
	const line = run.status === "idle" || run.status === "cancelled" ? unavailable ?? runLine(run) : runLine(run);
	if (line === null) return null;
	return <p className="character-drafter-status" role={run.status === "failed" || (unavailable !== null && run.status === "idle") ? "alert" : "status"} data-status={run.status}>{line}</p>;
}

// @approved
//  The drafter's window: whom to draft, picked from the people Memory knows
// or typed, an optional steer, then the agent's steps as it reads the story
// and, once it submits, the draft to open in the Definition editor.
export function DrafterWindow({ conversation }: { conversation: ConversationSummary }) {
	const read = useDrafterRead(conversation);
	const { run, start, cancel } = useDraftRun();
	const [person, setPerson] = useState("");
	const [instruction, setInstruction] = useState("");
	const enabled = conversation.boxes[descriptor.id] === "enabled";
	const unavailable = read.data?.unavailable ?? null;
	const people = read.data?.people ?? [];
	const running = run.status === "running";
	const draft = () => void start({ conversationId: conversation.id, person: person.trim(), instruction });
	const drafted = run.status === "drafted" ? run.draft : undefined;
	return <div className="character-drafter-window">
		<Field label="Person" htmlFor="character-drafter-person" helper={people.length === 0 ? "Type a name as the story writes it." : undefined}>
			<Input id="character-drafter-person" value={person} placeholder="Name" disabled={running} onChange={(event) => setPerson(event.target.value)} />
		</Field>
		{people.length > 0 && <div className="character-drafter-people" role="group" aria-label="People Memory knows">
			{people.map((label) => <Button key={label} type="button" size="xs" variant="ghost" aria-pressed={person === label} disabled={running} onClick={() => setPerson(label)}>
				{label}
			</Button>)}
		</div>}
		<Field label="Instruction" htmlFor="character-drafter-instruction">
			<Textarea id="character-drafter-instruction" value={instruction} rows={2} placeholder={STEER} disabled={running} onChange={(event) => setInstruction(event.target.value)} />
		</Field>
		<div className="character-drafter-actions">
			{running
				? <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
				: <Button type="button" variant={drafted === undefined ? "default" : "outline"} disabled={!enabled || unavailable !== null || person.trim() === ""} onClick={draft}>
					{run.status === "idle" ? "Draft" : "Draft again"}
				</Button>}
			{drafted !== undefined && <Button type="button" onClick={() => openDefinitionDraft(drafted, { conversationId: conversation.id })}>Open draft</Button>}
		</div>
		<DraftStatus run={run} unavailable={unavailable} />
		{run.status !== "idle" && <ActivityFeed activities={run.activities} />}
	</div>;
}
