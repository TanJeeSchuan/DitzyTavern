import { useState } from "react";
import { Portrait, Slider, type PortraitImage } from "@/box-sdk/client";
import type { RaceRead } from "./contract";
import { raceMoveCatalog } from "./shared";

// @approved
//  The finished race, Stretch by Stretch: each Runner's place, energy left,
//  the decisions it made (marked when the writer ordered them), and any
//  Hidden intent it was carrying.
export function RaceReplay({ replay, avatars }: { replay: NonNullable<RaceRead["replay"]>; avatars: ReadonlyMap<string, PortraitImage> }) {
	const [index, setIndex] = useState(0);
	const stretch = replay.stretches[index];
	if (stretch === undefined) return null;
	const last = replay.stretches.at(-1)!.stretch;
	return <section className="race-replay" aria-label="Replay">
		<div className="race-replay-heading">
			<h3>Replay</h3>
			<span>Stretch {stretch.stretch} · {replay.stretches[index - 1]?.metres ?? 0}–{stretch.metres} m</span>
		</div>
		<Slider aria-label="Replay Stretch" min={0} max={replay.stretches.length - 1} step={1} value={[index]} onValueChange={([value]) => setIndex(value ?? 0)} />
		<ol className="race-field race-replay-field" aria-label={`Stretch ${stretch.stretch}`}>
			{stretch.runners.map((runner, place) => {
				const intent = replay.intents.find(({ runner: name, formed, payoff }) => name === runner.name && formed <= stretch.stretch && stretch.stretch <= (payoff ?? last));
				return <li key={runner.name}>
					<span className="race-field-place">{place + 1}</span>
					<Portrait name={runner.name} portrait={avatars.get(runner.name)} size="small" />
					<span className="race-field-name">{runner.name}</span>
					<span className="race-replay-energy" title="Energy left">
						<span><span style={{ width: `${Math.round(runner.energy * 100)}%` }} /></span>
						<small>{Math.round(runner.energy * 100)}%</small>
					</span>
					<span className="race-replay-notes">
						{runner.decisions.map(({ kind, writer, success }, decision) => <span key={decision} data-missed={success ? undefined : true}>
							{raceMoveCatalog[kind].icon} {raceMoveCatalog[kind].label}{writer ? " (order)" : ""}{success ? "" : ", missed"}
						</span>)}
						{intent !== undefined && <span data-intent>{intent.payoff === stretch.stretch ? "Charges as planned" : "Planning a late charge"}</span>}
					</span>
				</li>;
			})}
		</ol>
		{replay.intents.length > 0 && <ul className="race-replay-intents" aria-label="Hidden intents">
			{replay.intents.map(({ runner, formed, payoff }) => <li key={runner}>
				{runner} planned a late charge in Stretch {formed}{payoff !== null && payoff <= last ? ` and launched it in Stretch ${payoff}.` : " but never launched it."}
			</li>)}
		</ul>}
	</section>;
}
