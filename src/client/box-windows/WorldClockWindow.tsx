import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { isWorldClockStart, weatherLabels, type WorldClockRecord, type WorldClockSetup } from "../../shared/contract/world-clock";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useSaveGuard } from "../SaveGuard";
import { boxDigestKey } from "./PassageTimeline";

const elapsedLabel = (minutes: number): string => {
	if (minutes === 0) return "No time passes";
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	if (hours === 0) return `+${remainder}m`;
	return remainder === 0 ? `+${hours}h` : `+${hours}h ${remainder}m`;
};

/** @approved A passage's record on the timeline, such as `+5m · ☀️ Clear`. */
export const describeWorldClock = ({ minutes, weather }: WorldClockRecord): string =>
	`${elapsedLabel(minutes)}${weather === null ? "" : ` · ${weatherLabels[weather]}`}`;

const conflictNotice = "The Chat changed elsewhere. Your draft was kept. Review it before saving again.";
const commandNotices = { conflict: conflictNotice, notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE };

/** @approved The World Clock's setup form; the host's passage timeline follows it in the window. */
export function WorldClockPanel({ conversation, disabled, onConversationChange }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}): ReactNode {
	const client = useQueryClient();
	const current = conversation.boxSetups["world-clock"];
	const [draft, setDraft] = useState<WorldClockSetup>(current);
	const [saved, setSaved] = useState(current);
	const [expectedRevision, setExpectedRevision] = useState(conversation.revision);
	const [pending, setPending] = useState(false);
	const [startTouched, setStartTouched] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	if (conversation.revision > expectedRevision && JSON.stringify(current) === JSON.stringify(saved)) setExpectedRevision(conversation.revision);
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const valid = isWorldClockStart(draft.start);
	const update = (patch: Partial<WorldClockSetup>) => setDraft((value) => ({ ...value, ...patch }));

	const save = async (): Promise<boolean> => {
		if (pending || disabled || !valid) return false;
		setPending(true);
		setNotice(null);
		let applied = false;
		try {
			await runConversationCommand({ conversationId: conversation.id, revision: () => expectedRevision, onConversationChange, setNotice }, { type: "set-box-setup", box: "world-clock", setup: draft }, {
				notices: commandNotices,
				onApplied: (next) => {
					setExpectedRevision(next.revision);
					setSaved(next.boxSetups["world-clock"]);
					applied = true;
					void client.invalidateQueries({ queryKey: boxDigestKey(conversation.id, "world-clock") });
				},
				onConflict: (next) => { setExpectedRevision(next.revision); setSaved(next.boxSetups["world-clock"]); },
			});
		} finally { setPending(false); }
		return applied;
	};
	const discard = () => { setDraft(current); setSaved(current); setExpectedRevision(conversation.revision); setNotice(null); };
	useSaveGuard({ dirty, saving: pending, save, discard });

	const locked = pending || disabled;
	return <div className="world-clock-window">
		<Field label="Start" htmlFor="world-clock-start" helper={!valid && startTouched ? "Enter a real calendar date and time." : undefined}>
			<Input id="world-clock-start" type="datetime-local" value={draft.start} disabled={locked} onChange={(event) => update({ start: event.target.value })} onBlur={() => setStartTouched(true)} />
		</Field>
		<Field label="Era" htmlFor="world-clock-era">
			<Input id="world-clock-era" value={draft.era} maxLength={16} disabled={locked} onChange={(event) => update({ era: event.target.value })} />
		</Field>
		<Field label="Climate">
			<SegmentedControl label="Climate" value={draft.climate} disabled={locked} onValueChange={(climate) => update({ climate })}
				options={[{ value: "temperate", label: "Temperate" }, { value: "tropical", label: "Tropical" }, { value: "arid", label: "Arid" }, { value: "cold", label: "Cold" }]} />
		</Field>
		<Field label="Hemisphere">
			<SegmentedControl label="Hemisphere" value={draft.hemisphere} disabled={locked} onValueChange={(hemisphere) => update({ hemisphere })}
				options={[{ value: "north", label: "North" }, { value: "south", label: "South" }]} />
		</Field>
		<Field label="Temperature">
			<SegmentedControl label="Temperature unit" value={draft.unit} disabled={locked} onValueChange={(unit) => update({ unit })}
				options={[{ value: "C", label: "°C" }, { value: "F", label: "°F" }]} />
		</Field>
		{notice !== null && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
		<div className="world-clock-actions">
			{notice !== null && <Button variant="ghost" disabled={pending} onClick={discard}>Load saved setup</Button>}
			<Button disabled={locked || !dirty || !valid} onClick={() => void save()}>{pending ? "Saving…" : "Save World Clock"}</Button>
		</div>
	</div>;
}
