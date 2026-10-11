import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Pencil } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	elapsedBinNames, elapsedBins, elapsedBinMinutes, isWorldClockStart, weathers,
	type ElapsedBin, type Weather, type WorldClockPassage, type WorldClockRead, type WorldClockSetup,
} from "../../shared/contract/box";
import type { ConversationAction, ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useSaveGuard } from "../SaveGuard";
import { cancelWorldClockCatchUp, loadWorldClock, startWorldClockCatchUp } from "../world-clock";

const worldClockKey = (conversationId: number) => ["world-clock", conversationId] as const;

/** @approved The window and the dock share one polled read: a digest that
 *  lands while either is mounted refreshes the status and the timeline, and a
 *  running catch-up polls faster so its progress moves. */
function useWorldClock(conversationId: number) {
	return useQuery({
		queryKey: worldClockKey(conversationId),
		queryFn: ({ signal }) => loadWorldClock(conversationId, signal),
		refetchInterval: (query) => query.state.data?.catchUp == null ? 2_500 : 750,
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

const conflictNotice = "The Chat changed elsewhere. Your draft was kept. Review it before saving again.";
const commandNotices = { conflict: conflictNotice, notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE };

// @approved
//  Radix Select item values must be non-empty, so keeping the current elapsed
//  time and clearing weather have their own sentinels outside the real values.
const keepElapsed = "keep";
const noWeather = "none";

type PassageDraft = { readonly messageId: number; readonly variantId: number; readonly bin: ElapsedBin | null; readonly weather: Weather | null };

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

/** @approved The World Clock window: the Chat's setup, plus a passage
 *  timeline whose Writer overrides and catch-up runs edit the clock. */
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
	const [editing, setEditing] = useState<PassageDraft | null>(null);
	const [passageBusy, setPassageBusy] = useState<number | null>(null);
	const [catchUpBusy, setCatchUpBusy] = useState(false);
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
	const catchUp = read.data?.catchUp ?? null;
	const digestReady = read.data?.digestReady ?? false;
	const startEditing = (passage: WorldClockPassage) => setEditing({ messageId: passage.messageId, variantId: passage.variantId, bin: null, weather: passage.record?.weather ?? null });

	const applyRecord = async (passage: WorldClockPassage, command: ConversationAction): Promise<boolean> => {
		let applied = false;
		setPassageBusy(passage.variantId);
		setNotice(null);
		try {
			await runConversationCommand({ conversationId: conversation.id, revision: () => expectedRevision, onConversationChange, setNotice }, command, {
				notices: commandNotices,
				onApplied: (next) => { setExpectedRevision(next.revision); applied = true; void client.invalidateQueries({ queryKey: worldClockKey(conversation.id) }); },
				onConflict: (next) => setExpectedRevision(next.revision),
			});
		} finally { setPassageBusy(null); }
		return applied;
	};
	const savePassage = async (passage: WorldClockPassage) => {
		if (editing === null || editing.variantId !== passage.variantId || locked) return;
		const minutes = editing.bin === null ? passage.record?.minutes : elapsedBinMinutes(editing.bin);
		if (minutes === undefined) return;
		const applied = await applyRecord(passage, {
			type: "set-box-record", box: "world-clock", messageId: editing.messageId, variantId: editing.variantId,
			record: { minutes, weather: editing.weather },
		});
		if (applied) setEditing(null);
	};
	const resetPassage = (passage: WorldClockPassage) =>
		applyRecord(passage, { type: "reset-box-record", box: "world-clock", messageId: passage.messageId, variantId: passage.variantId });

	const runCatchUp = async (task: () => Promise<WorldClockRead | null>) => {
		setCatchUpBusy(true);
		setNotice(null);
		try {
			const result = await task();
			if (result === null) setNotice(CONVERSATION_UNREACHABLE_NOTICE);
			else client.setQueryData(worldClockKey(conversation.id), result);
		} catch { setNotice(CONVERSATION_UNREACHABLE_NOTICE); } finally { setCatchUpBusy(false); }
	};
	const missing = passages.some((passage) => !passage.digested);
	const catchUpDisabled = locked || catchUpBusy || !saved.enabled || !digestReady || !missing;

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
			<div className="world-clock-timeline-head">
				<h3 id="world-clock-passages-title">Passages</h3>
				{catchUp === null
					? <Button variant="outline" size="sm" disabled={catchUpDisabled} onClick={() => void runCatchUp(() => startWorldClockCatchUp(conversation.id))}>
						Digest missing passages
					</Button>
					: <span className="world-clock-progress" role="status">
						Digesting {catchUp.total - catchUp.remaining} of {catchUp.total}…
						<Button variant="ghost" size="sm" disabled={catchUpBusy} onClick={() => void runCatchUp(() => cancelWorldClockCatchUp(conversation.id))}>Cancel</Button>
					</span>}
			</div>
			{!digestReady && <p className="world-clock-note" role="status">Select a World Clock Decision Model in Connection Settings to digest passages.</p>}
			{read.isError && <p role="alert">The World Clock could not be read.</p>}
			{read.isSuccess && passages.length === 0 && <p className="world-clock-note">No passages yet.</p>}
			<ol>
				{passages.map((passage) => (
					<li key={passage.variantId}>
						<strong>{passage.author ?? "Unknown"}</strong>
						<span className="world-clock-passage-text">{passage.content}</span>
						{editing?.variantId === passage.variantId
							? <div className="world-clock-passage-editor">
								<Field label="Elapsed time">
									<Select value={editing.bin ?? (passage.record === null ? "" : keepElapsed)} disabled={passageBusy !== null}
										onValueChange={(value) => setEditing((active) => active === null ? null : { ...active, bin: elapsedBinNames.find((bin) => bin === value) ?? null })}>
										<SelectTrigger size="sm" aria-label="Elapsed time"><SelectValue placeholder="Choose an elapsed time" /></SelectTrigger>
										<SelectContent>
											{passage.record !== null && <SelectItem value={keepElapsed}>{`Keep ${elapsedLabel(passage.record.minutes)}`}</SelectItem>}
											{elapsedBinNames.map((bin) => <SelectItem key={bin} value={bin}>{elapsedBins[bin].label}</SelectItem>)}
										</SelectContent>
									</Select>
								</Field>
								<Field label="Weather">
									<Select value={editing.weather ?? noWeather} disabled={passageBusy !== null}
										onValueChange={(value) => setEditing((active) => active === null ? null : { ...active, weather: weathers.find((kind) => kind === value) ?? null })}>
										<SelectTrigger size="sm" aria-label="Weather"><SelectValue /></SelectTrigger>
										<SelectContent>
											<SelectItem value={noWeather}>Not mentioned</SelectItem>
											{weathers.map((kind) => <SelectItem key={kind} value={kind}>{weatherLabels[kind]}</SelectItem>)}
										</SelectContent>
									</Select>
								</Field>
								<div className="world-clock-passage-actions">
									<Button variant="ghost" size="sm" disabled={passageBusy !== null} onClick={() => setEditing(null)}>Cancel</Button>
									<Button size="sm" disabled={passageBusy !== null || (editing.bin === null && passage.record === null)} onClick={() => void savePassage(passage)}>Save override</Button>
								</div>
							</div>
							: <div className="world-clock-passage-read">
								<span className="world-clock-passage-summary">
									{passage.record === null
										? <em>Not read yet</em>
										: <>{elapsedLabel(passage.record.minutes)}{passage.record.weather === null ? "" : ` · ${weatherLabels[passage.record.weather]}`}</>}
									{passage.overridden && <span className="world-clock-override-mark">Overridden</span>}
								</span>
								<span className="world-clock-passage-actions">
									<Button variant="ghost" size="sm" disabled={locked || passageBusy !== null} onClick={() => startEditing(passage)}><Pencil aria-hidden="true" />Edit</Button>
									{passage.overridden && <Button variant="ghost" size="sm" disabled={locked || passageBusy !== null} onClick={() => void resetPassage(passage)}>Reset</Button>}
								</span>
							</div>}
					</li>
				))}
			</ol>
		</section>
	</div>;
}
