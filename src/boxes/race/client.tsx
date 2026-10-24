import "./client.css";
import { useState, type ComponentProps } from "react";
import { Flag } from "lucide-react";
import { Button, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, type BoxClientDefinition, type ConversationSummary, type MoveStaging } from "@/box-sdk/client";
import { boxMovesOf, boxSetupOf } from "@/box-sdk/shared";
import { raceMove, raceSetup, type RaceMoveKind } from "./contract";
import { checkRaceMove, raceMoveCatalog } from "./shared";
import { RaceStatus, RaceWindow, useRace } from "./client-window";
import descriptor from "./shared-descriptor";

const kinds = /* @approved SAFETY: Object.keys of the literal catalog returns exactly its keys. */ Object.keys(raceMoveCatalog) as RaceMoveKind[];

// @approved
//  Offers only the Moves legal after the ones already staged, each with its
//  projected energy cost and odds. The human-seat Runner is the gate whose
//  Participant is the human-controlled one; otherwise Moves are orders to
//  the Runner the writer picks. While the read of a new revision loads, the
//  offers come from the previous state, so none of them stages a Move.
function RaceMoves({ conversation, disabled, staging }: { conversation: ConversationSummary; disabled: boolean; staging: MoveStaging | null }) {
	const read = useRace(conversation);
	const setup = boxSetupOf(conversation, "race", raceSetup);
	const humanSeatId = conversation.control.humanParticipantId;
	const seat = humanSeatId === null ? undefined : setup.slots.find(({ participantId }) => participantId === humanSeatId)?.name;
	const seated = seat !== undefined;
	const [ordered, setOrdered] = useState<string | undefined>(undefined);
	const runner = seated ? seat : ordered ?? setup.slots[0]?.name;
	const state = read.data?.state;
	if (setup.phase !== "running" || state === undefined || state.finished || runner === undefined) return null;
	const staged = staging === null ? [] : boxMovesOf(staging.moves, "race", raceMove);
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
			{offers.map(({ kind, check }) => check.legal && <Button key={kind} variant="outline" size="sm" disabled={disabled || staging === null || read.isPlaceholderData}
				onClick={() => staging?.onChange({ ...staging.moves, race: [...staged, { kind, runner }] })}>
				{raceMoveCatalog[kind].icon} {raceMoveCatalog[kind].label}
				<small>{check.cost === 0 ? "" : `${check.cost > 0 ? "−" : "+"}${Math.round(Math.abs(check.cost) * 100)}% energy · `}{Math.round(check.odds * 100)}%</small>
			</Button>)}
		</div>
		{!open.legal ? <p>{open.reason}</p> : offers.every(({ check }) => !check.legal) && <p>No more Moves this Stretch.</p>}
	</section>;
}

function RacePanel(props: ComponentProps<typeof RaceWindow> & { staging: MoveStaging | null }) {
	return <>
		<RaceWindow {...props} />
		<RaceMoves {...props} />
	</>;
}

export default { descriptor, icon: Flag, Status: RaceStatus, Window: { size: { width: 27, height: 34 }, Panel: RacePanel } } satisfies BoxClientDefinition;
