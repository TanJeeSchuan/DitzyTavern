import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { isWorldClockStart, type Weather, type WorldClockSetup } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useSaveGuard } from "../SaveGuard";
import { loadWorldClock } from "../world-clock";

const worldClockKey = (conversationId: number) => ["world-clock", conversationId] as const;

/** @approved The window and the dock share one polled read: a digest that
 *  lands while either is mounted refreshes the status and the timeline. */
function useWorldClock(conversationId: number) {
	return useQuery({
		queryKey: worldClockKey(conversationId),
		queryFn: ({ signal }) => loadWorldClock(conversationId, signal),
		refetchInterval: 2_500,
		refetchIntervalInBackground: false,
	});
}

const weatherLabels = {
	clear: "☀️ Clear",
	cloudy: "☁️ Cloudy",
	rain: "🌧️ Rain",
	storm: "⛈️ Storm",
	snow: "🌨️ Snow",
	fog: "🌫️ Fog",
} satisfies Record<Weather, string>;

const elapsedLabel = (minutes: number): string => {
	if (minutes === 0) return "No time passes";
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	if (hours === 0) return `+${remainder}m`;
	return remainder === 0 ? `+${hours}h` : `+${hours}h ${remainder}m`;
};

export function WorldClockDockTab({ conversation, onRestore }: {
	conversation: ConversationSummary;
	onRestore: () => void;
}): ReactNode {
	const read = useWorldClock(conversation.id);
	const status = read.data?.status ?? (read.isError ? "Unavailable" : "Reading…");
	return <button type="button" className="box-dock-tab" title="Restore World Clock" onClick={onRestore}>
		<Clock aria-hidden="true" />
		<span className="sr-only">World Clock: </span>
		<span>{status}</span>
	</button>;
}

/** @approved The World Clock window: the Chat's setup and a passage timeline
 *  with each selected passage's elapsed time and weather. */
export function WorldClockWindow({ conversation, disabled, onConversationChange }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}): ReactNode {
	const client = useQueryClient();
	const read = useWorldClock(conversation.id);
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
				notices: {
					conflict: "The Chat changed elsewhere. Your draft was kept. Review it before saving again.",
					notFound: CONVERSATION_UNREACHABLE_NOTICE,
					unreachable: CONVERSATION_UNREACHABLE_NOTICE,
				},
				onApplied: (next) => {
					setExpectedRevision(next.revision);
					setSaved(next.boxSetups["world-clock"]);
					applied = true;
					void client.invalidateQueries({ queryKey: worldClockKey(conversation.id) });
				},
				onConflict: (next) => { setExpectedRevision(next.revision); setSaved(next.boxSetups["world-clock"]); },
			});
		} finally { setPending(false); }
		return applied;
	};
	const discard = () => { setDraft(current); setSaved(current); setExpectedRevision(conversation.revision); setNotice(null); };
	useSaveGuard({ dirty, saving: pending, save, discard });

	const locked = pending || disabled;
	const passages = read.data?.passages ?? [];
	return <div className="world-clock-window">
		<div className="world-clock-toggle">
			<div>
				<strong>Track this Chat</strong>
				<p>The World Clock sends the current time and weather with each Generation.</p>
			</div>
			<Switch checked={draft.enabled} disabled={locked} aria-label={draft.enabled ? "Turn off the World Clock" : "Turn on the World Clock"} onCheckedChange={(enabled) => update({ enabled })} />
		</div>
		{!draft.enabled && <p className="world-clock-note" role="status">The clock is off. Turn it on to send the time and read passages.</p>}
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
		<section aria-labelledby="world-clock-passages-title" className="world-clock-timeline">
			<h3 id="world-clock-passages-title">Passages</h3>
			{read.isError && <p role="alert">The World Clock could not be read.</p>}
			{read.isSuccess && passages.length === 0 && <p className="world-clock-note">No passages yet.</p>}
			<ol>
				{passages.map((passage) => (
					<li key={passage.variantId}>
						<strong>{passage.author ?? "Unknown"}</strong>
						<span className="world-clock-passage-text">{passage.content}</span>
						<span className="world-clock-passage-read">
							{passage.record === null
								? <em>Not read yet</em>
								: <>{elapsedLabel(passage.record.minutes)}{passage.record.weather === null ? "" : ` · ${weatherLabels[passage.record.weather]}`}{passage.overridden ? " · Overridden" : ""}</>}
						</span>
					</li>
				))}
			</ol>
		</section>
	</div>;
}
