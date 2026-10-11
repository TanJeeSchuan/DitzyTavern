import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Value } from "@sinclair/typebox/value";
import { worldClockSetup, type WorldClockSetup } from "../shared/contract/box";
import type { ConversationSummary } from "./conversation";
import { runConversationCommand, CONVERSATION_UNREACHABLE_NOTICE } from "./conversation-command-runner";
import { useSaveGuard } from "./SaveGuard";

// @approved
//  Interim World Clock setup form; the World Clock window replaces it.
export function WorldClockPanel({ conversation, onConversationChange, disabled }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	disabled: boolean;
}) {
	const current = conversation.boxSetups["world-clock"];
	const [draft, setDraft] = useState<WorldClockSetup>(current);
	const [saved, setSaved] = useState(current);
	const [expectedRevision, setExpectedRevision] = useState(conversation.revision);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	if (conversation.revision > expectedRevision && JSON.stringify(current) === JSON.stringify(saved)) setExpectedRevision(conversation.revision);
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const valid = Value.Check(worldClockSetup.properties.start, draft.start);
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
				onApplied: (next) => { setExpectedRevision(next.revision); setSaved(next.boxSetups["world-clock"]); applied = true; },
				onConflict: (next) => { setExpectedRevision(next.revision); setSaved(next.boxSetups["world-clock"]); },
			});
		} finally { setPending(false); }
		return applied;
	};
	const discard = () => { setDraft(current); setSaved(current); setExpectedRevision(conversation.revision); setNotice(null); };
	useSaveGuard({ dirty, saving: pending, save, discard });

	const locked = pending || disabled;
	return <div className="panel-fill grid content-start gap-4 overflow-y-auto p-5">
		<p className="text-sm text-muted-foreground">Where this Chat's clock starts. Choose a World Clock Decision Model in Connections to advance it.</p>
		<Field label="Start" htmlFor="world-clock-start" helper={valid ? undefined : "Enter a full date and time."}>
			<Input id="world-clock-start" type="datetime-local" value={draft.start} disabled={locked} onChange={(event) => update({ start: event.target.value })} />
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
		<div className="flex justify-end gap-2">
			{notice !== null && <Button variant="ghost" disabled={pending} onClick={discard}>Load saved setup</Button>}
			<Button disabled={locked || !dirty || !valid} onClick={() => void save()}>{pending ? "Saving…" : "Save World Clock"}</Button>
		</div>
	</div>;
}
