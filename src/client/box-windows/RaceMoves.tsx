import { useQuery } from "@tanstack/react-query";
import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { RaceMoveKind } from "../../shared/contract/race";
import { checkRaceMove, raceMoveCatalog } from "../../shared/race-moves";
import type { ConversationSummary } from "../conversation";
import { loadRace } from "../race";
import { RaceWindow } from "./RaceWindow";
import type { MoveStaging } from "./registry";

const kinds = /* @approved SAFETY: Object.keys of the literal catalog returns exactly its keys. */ Object.keys(raceMoveCatalog) as RaceMoveKind[];

// @approved
//  Offers only the Moves legal after the ones already staged, each with its
//  projected energy cost and odds. The human-seat Runner is the one whose
//  name matches the human-controlled Participant; otherwise Moves are orders
//  to the Runner the writer picks.
function RaceMoves({ conversation, disabled, staging }: { conversation: ConversationSummary; disabled: boolean; staging: MoveStaging }) {
	const read = useQuery({ queryKey: ["race", conversation.id, conversation.revision], queryFn: ({ signal }) => loadRace(conversation.id, signal) });
	const setup = conversation.boxSetups.race;
	const seat = conversation.cast.find(({ id }) => id === conversation.control.humanParticipantId)?.name;
	const seated = setup.slots.some(({ name }) => name === seat);
	const [ordered, setOrdered] = useState<string | undefined>(undefined);
	const runner = seated ? seat : ordered ?? setup.slots[0]?.name;
	const state = read.data?.state;
	if (setup.phase !== "running" || state === undefined || state.finished || runner === undefined) return null;
	const staged = staging.moves.race ?? [];
	const offers = kinds.map((kind) => ({ kind, check: checkRaceMove(setup, state, staged, { kind, runner }) }));
	const open = checkRaceMove(setup, state, [], { kind: "hold", runner });
	return <section className="race-moves" aria-label="Race Moves">
		{seated ? <p>Moves for {runner}</p> : <Field label="Order Runner">
			<Select value={runner} onValueChange={setOrdered} disabled={disabled}>
				<SelectTrigger aria-label="Order Runner"><SelectValue /></SelectTrigger>
				<SelectContent>{setup.slots.map(({ name }) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
			</Select>
		</Field>}
		<div className="race-moves-offer">
			{offers.map(({ kind, check }) => check.legal && <Button key={kind} variant="outline" size="sm" disabled={disabled}
				onClick={() => staging.onChange({ ...staging.moves, race: [...staged, { kind, runner }] })}>
				{raceMoveCatalog[kind].icon} {raceMoveCatalog[kind].label}
				<small>{check.cost === 0 ? "" : `${check.cost > 0 ? "−" : "+"}${Math.round(Math.abs(check.cost) * 100)}% energy · `}{Math.round(check.odds * 100)}%</small>
			</Button>)}
		</div>
		{!open.legal ? <p>{open.reason}</p> : offers.every(({ check }) => !check.legal) && <p>No more Moves this Stretch.</p>}
	</section>;
}

export function RacePanel(props: ComponentProps<typeof RaceWindow> & { staging: MoveStaging }) {
	return <>
		<RaceWindow {...props} />
		<RaceMoves {...props} />
	</>;
}
